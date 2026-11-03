use crate::entities::{
    cp_billing_profiles as billing, cp_checkout_attempts as checkouts, cp_invites as invites,
    cp_machine_registrations as registrations, cp_members as members, cp_site_settings as settings,
    cp_teams as teams, cp_users as users,
};
use crate::policies::{
    TeamAction, TeamCreationAction, TeamCreationPolicy, TeamPolicy, TeamScope, authorize,
};
use crate::{
    ControlStore, Error, Result, name, now_ms, one_query, resource_id, secret, secret_hash,
    timestamp,
};
use deskfleet_protocol::control::Team;
use sea_orm::sea_query::{
    Alias, Asterisk, Cond, Expr, ExprTrait, JoinType, LockType, OnConflict, Order, Query, UnionType,
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect, Set, TransactionTrait,
};
use serde_json::{Value, json};

impl ControlStore {
    pub(crate) async fn team_policy(&self, user_id: &str, team_id: &str) -> Result<TeamPolicy> {
        team_policy(&self.db, user_id, team_id).await
    }
    pub async fn team_role(&self, user_id: &str, team_id: &str) -> Result<String> {
        let policy = self.team_policy(user_id, team_id).await?;
        authorize(&policy, TeamAction::Read)?;
        Ok(policy.role().ok_or(Error::Forbidden)?.as_str().into())
    }
    /// Authorize a Team action against the caller's current membership.
    ///
    /// # Errors
    /// Returns an error for denied actions, invalid IDs, or database failures.
    pub async fn authorize_team(
        &self,
        user_id: &str,
        team_id: &str,
        action: TeamAction,
    ) -> Result<()> {
        authorize(&self.team_policy(user_id, team_id).await?, action)
    }
    pub async fn require_admin(&self, user_id: &str, team_id: &str) -> Result<()> {
        self.authorize_team(user_id, team_id, TeamAction::ManageMembers)
            .await
    }
    pub async fn teams(&self, user_id: &str) -> Result<Vec<Team>> {
        TeamScope::new(user_id).resolve(self).await
    }
    /// Return cumulative TURN outbound bytes and current Team resource counts.
    ///
    /// Sessions use their latest synchronized archive state, independent of
    /// execution or machine presence. Removed machines do not contribute.
    ///
    /// # Errors
    /// Returns an error for nonmembers, an invalid Team ID, or a database failure.
    pub async fn team_usage(&self, user_id: &str, team_id: &str) -> Result<Value> {
        self.authorize_team(user_id, team_id, TeamAction::ReadUsage)
            .await?;
        let mut summary = self.billing_summary(team_id).await?;
        let mut usage = summary["usage"].take();
        usage["plan"] = summary["plan"].take();
        usage["limits"] = summary["limits"].take();
        usage["period"] = summary["period"].take();
        usage["nextResetAt"] = summary["nextResetAt"].take();
        usage["metering"] = summary["metering"].take();
        Ok(usage)
    }
    pub async fn create_team(&self, user_id: &str, value: &str) -> Result<Team> {
        let value = name(value)?;
        let tx = self.db.begin().await?;
        let allow_creation = settings::Entity::find_by_id(true)
            .lock_shared()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?
            .allow_team_creation;
        authorize(
            &TeamCreationPolicy::new(allow_creation),
            TeamCreationAction::Create,
        )?;
        let id = teams::Entity::insert(teams::ActiveModel {
            name: Set(value.into()),
            ..Default::default()
        })
        .exec_with_returning(&tx)
        .await?
        .id;
        billing::Entity::insert(billing::ActiveModel {
            team_id: Set(id),
            period_anchor: Set(now_ms()),
            ..Default::default()
        })
        .exec_without_returning(&tx)
        .await?;
        members::Entity::insert(members::ActiveModel {
            team_id: Set(id),
            user_id: Set(user_id.into()),
            role: Set("owner".into()),
        })
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(Team {
            id: id.to_string(),
            name: value.to_owned(),
            role: "owner".into(),
        })
    }
    pub async fn rename_team(&self, user_id: &str, team_id: &str, value: &str) -> Result<Team> {
        let value = name(value)?;
        let tx = self.db.begin().await?;
        let policy = lock_team_policy(&tx, user_id, team_id).await?;
        authorize(&policy, TeamAction::Rename)?;
        teams::Entity::update_many()
            .col_expr(teams::Column::Name, Expr::val(value))
            .filter(teams::Column::Id.eq(resource_id(team_id)?))
            .exec(&tx)
            .await?;
        tx.commit().await?;
        Ok(Team {
            id: team_id.into(),
            name: value.into(),
            role: policy.role().ok_or(Error::Forbidden)?.as_str().into(),
        })
    }
    pub async fn delete_team(&self, user_id: &str, team_id: &str) -> Result<()> {
        self.authorize_team(user_id, team_id, TeamAction::Delete)
            .await?;
        let tx = self.db.begin().await?;
        let id = resource_id(team_id)?;
        teams::Entity::find_by_id(id)
            .lock_exclusive()
            .select_only()
            .column(teams::Column::Id)
            .into_tuple::<i64>()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        authorize(
            &team_policy(&tx, user_id, team_id).await?,
            TeamAction::Delete,
        )?;
        let checkout = Query::select()
            .column(checkouts::Column::TeamId)
            .from(checkouts::Entity)
            .and_where(checkouts::Column::TeamId.eq(id))
            .to_owned();
        if tx
            .query_one(
                Query::select()
                    .column(billing::Column::TeamId)
                    .from(billing::Entity)
                    .and_where(billing::Column::TeamId.eq(id))
                    .cond_where(
                        Cond::any()
                            .add(billing::Column::CustomerId.is_not_null())
                            .add(billing::Column::SubscriptionId.is_not_null())
                            .add(billing::Column::LeaseUntil.gt(now_ms())),
                    )
                    .union(UnionType::All, checkout)
                    .limit(1),
            )
            .await?
            .is_some()
        {
            return Err(Error::Conflict(
                "team owns billing records and cannot be deleted",
            ));
        }
        if registrations::Entity::find()
            .filter(registrations::Column::TeamId.eq(id))
            .one(&tx)
            .await?
            .is_some()
        {
            return Err(Error::Conflict("team still owns machine records"));
        }
        teams::Entity::delete_by_id(id).exec(&tx).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn members(&self, user_id: &str, team_id: &str) -> Result<Vec<Value>> {
        self.authorize_team(user_id, team_id, TeamAction::ReadMembers)
            .await?;
        self.db.query_all(Query::select().columns([(users::Entity, users::Column::Id), (users::Entity, users::Column::Name), (users::Entity, users::Column::Email)])
            .column((members::Entity, members::Column::Role)).from(members::Entity).join(JoinType::InnerJoin, users::Entity,
                Expr::col((users::Entity, users::Column::Id)).eq(Expr::col((members::Entity, members::Column::UserId))))
            .and_where(members::Column::TeamId.eq(resource_id(team_id)?)).order_by((users::Entity, users::Column::Id), Order::Asc))
            .await?.into_iter().map(|row| Ok(json!({"userId":row.try_get::<String>("","id")?,"name":row.try_get::<String>("","name")?,
                "email":row.try_get::<String>("","email")?,"role":row.try_get::<String>("","role")?}))).collect()
    }
    pub async fn change_member(
        &self,
        actor: &str,
        team_id: &str,
        user_id: &str,
        role: Option<&str>,
    ) -> Result<()> {
        if role.is_some_and(|r| r != "admin" && r != "member") {
            return Err(Error::Invalid("invalid team role"));
        }
        let tx = self.db.begin().await?;
        let id = resource_id(team_id)?;
        teams::Entity::find_by_id(id)
            .lock_exclusive()
            .select_only()
            .column(teams::Column::Id)
            .into_tuple::<i64>()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        authorize(
            &team_policy(&tx, actor, team_id).await?,
            TeamAction::ManageMembers,
        )?;
        let current = members::Entity::find_by_id((id, user_id.to_owned()))
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?
            .role;
        if current == "owner" {
            return Err(Error::Conflict(
                "transfer team ownership before changing the owner",
            ));
        }
        if let Some(role) = role {
            members::Entity::update_many()
                .col_expr(members::Column::Role, Expr::val(role))
                .filter(members::Column::TeamId.eq(id))
                .filter(members::Column::UserId.eq(user_id))
                .exec(&tx)
                .await?;
        } else {
            members::Entity::delete_by_id((id, user_id.to_owned()))
                .exec(&tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
    /// Transfer the unique ownership to an existing active Team member.
    ///
    /// The previous owner remains an administrator; billing records stay with
    /// the Team, including the existing payment method and subscription.
    ///
    /// # Errors
    /// Returns an error unless the actor is the current owner, the target is
    /// another active verified member, and the transaction can commit.
    pub async fn transfer_team_ownership(
        &self,
        actor: &str,
        team_id: &str,
        target_user_id: &str,
    ) -> Result<()> {
        let tx = self.db.begin().await?;
        let id = resource_id(team_id)?;
        // Both accounts must stay active until commit. Lock users before the
        // Team, matching other membership mutations and peer creation.
        users::Entity::find_by_id(target_user_id)
            .filter(users::Column::EmailVerified.eq(true))
            .filter(users::Column::Disabled.eq(false))
            .lock_shared()
            .select_only()
            .column(users::Column::Id)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::Invalid(
                "new owner must be an active verified team member",
            ))?;
        authorize(
            &lock_team_policy(&tx, actor, team_id).await?,
            TeamAction::TransferOwnership,
        )?;
        if actor == target_user_id {
            return Err(Error::Invalid("target is already the team owner"));
        }
        if tx
            .query_one(
                member_query(target_user_id, id).column((members::Entity, members::Column::UserId)),
            )
            .await?
            .is_none()
        {
            return Err(Error::Invalid(
                "new owner must be an active verified team member",
            ));
        }
        // Demote first so the unique owner index holds throughout the transaction.
        members::Entity::update_many()
            .col_expr(members::Column::Role, Expr::val("admin"))
            .filter(members::Column::TeamId.eq(id))
            .filter(members::Column::UserId.eq(actor))
            .exec(&tx)
            .await?;
        members::Entity::update_many()
            .col_expr(members::Column::Role, Expr::val("owner"))
            .filter(members::Column::TeamId.eq(id))
            .filter(members::Column::UserId.eq(target_user_id))
            .exec(&tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn invite(
        &self,
        user_id: &str,
        team_id: &str,
        email: &str,
        role: &str,
    ) -> Result<Value> {
        if role != "admin" && role != "member" {
            return Err(Error::Invalid("invalid team role"));
        }
        let email = crate::normalize_email(email)?;
        let token = secret();
        let expires = now_ms() + 7 * 24 * 60 * 60 * 1000;
        let tx = self.db.begin().await?;
        authorize(
            &lock_team_policy(&tx, user_id, team_id).await?,
            TeamAction::ManageMembers,
        )?;
        invites::Entity::insert(invites::ActiveModel {
            token_hash: Set(secret_hash(&token)),
            team_id: Set(resource_id(team_id)?),
            email: Set(email),
            role: Set(role.into()),
            expires_at: Set(expires),
        })
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(json!({"token":token,"expiresAt":timestamp(expires)}))
    }
    pub async fn accept_invite(&self, user_id: &str, token: &str) -> Result<Team> {
        let tx = self.db.begin().await?;
        let id = invites::Entity::find_by_id(secret_hash(token))
            .filter(invites::Column::ExpiresAt.gt(now_ms()))
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?
            .team_id;
        // Account disabling and email changes must finish before checking the
        // invitee, or wait until membership and invitation consumption commit.
        let user = users::Entity::find_by_id(user_id)
            .filter(users::Column::EmailVerified.eq(true))
            .filter(users::Column::Disabled.eq(false))
            .lock_shared()
            .one(&tx)
            .await?
            .ok_or(Error::Forbidden)?;
        // Team deletion locks the parent before cascading to its invitations.
        teams::Entity::find_by_id(id)
            .lock_exclusive()
            .select_only()
            .column(teams::Column::Id)
            .into_tuple::<i64>()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        let invite = one_query(
            &tx,
            Query::select()
                .columns([
                    (invites::Entity, invites::Column::TeamId),
                    (invites::Entity, invites::Column::Email),
                    (invites::Entity, invites::Column::Role),
                ])
                .column((teams::Entity, teams::Column::Name))
                .from(invites::Entity)
                .join(
                    JoinType::InnerJoin,
                    teams::Entity,
                    Expr::col((teams::Entity, teams::Column::Id))
                        .eq(Expr::col((invites::Entity, invites::Column::TeamId))),
                )
                .and_where(invites::Column::TokenHash.eq(secret_hash(token)))
                .and_where(invites::Column::ExpiresAt.gt(now_ms()))
                .lock_with_tables(LockType::Update, [invites::Entity]),
        )
        .await?;
        if user.email.to_lowercase() != invite.try_get::<String>("", "email")? {
            return Err(Error::Forbidden);
        }
        let role = invite.try_get::<String>("", "role")?;
        let existing = members::Entity::find_by_id((id, user_id.to_owned()))
            .one(&tx)
            .await?
            .map(|row| row.role);
        if existing.is_none() {
            let plan = crate::billing::effective_plan(&tx, id, self.hosted, now_ms()).await?;
            if let Some(limit) = plan.limits().max_members {
                let count: i64 = one_query(
                    &tx,
                    Query::select()
                        .expr_as(Expr::col(Asterisk).count(), Alias::new("count"))
                        .from(members::Entity)
                        .and_where(members::Column::TeamId.eq(id)),
                )
                .await?
                .try_get("", "count")?;
                if count >= limit {
                    return Err(Error::Conflict("member_limit"));
                }
            }
        }
        members::Entity::insert(members::ActiveModel {
            team_id: Set(id),
            user_id: Set(user_id.into()),
            role: Set(role.clone()),
        })
        .on_conflict(
            OnConflict::columns([members::Column::TeamId, members::Column::UserId])
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(&tx)
        .await?;
        invites::Entity::delete_by_id(secret_hash(token))
            .exec(&tx)
            .await?;
        tx.commit().await?;
        Ok(Team {
            id: id.to_string(),
            name: invite.try_get("", "name")?,
            role: existing.unwrap_or(role),
        })
    }
    pub async fn team_user_ids(&self, team_id: &str) -> Result<Vec<String>> {
        Ok(members::Entity::find()
            .select_only()
            .column(members::Column::UserId)
            .filter(members::Column::TeamId.eq(resource_id(team_id)?))
            .into_tuple()
            .all(&self.db)
            .await?)
    }
}

/// Hold authorization through commit. Parent locks precede membership and Machine
/// writes, matching peer creation and Team membership mutations.
pub(crate) async fn lock_team_policy(
    db: &impl ConnectionTrait,
    user_id: &str,
    team_id: &str,
) -> Result<TeamPolicy> {
    users::Entity::find_by_id(user_id)
        .filter(users::Column::EmailVerified.eq(true))
        .filter(users::Column::Disabled.eq(false))
        .lock_shared()
        .select_only()
        .column(users::Column::Id)
        .into_tuple::<String>()
        .one(db)
        .await?
        .ok_or(Error::Forbidden)?;
    teams::Entity::find_by_id(resource_id(team_id)?)
        .lock_exclusive()
        .select_only()
        .column(teams::Column::Id)
        .into_tuple::<i64>()
        .one(db)
        .await?
        .ok_or(Error::NotFound)?;
    team_policy(db, user_id, team_id).await
}
async fn team_policy(
    db: &impl ConnectionTrait,
    user_id: &str,
    team_id: &str,
) -> Result<TeamPolicy> {
    let role = db
        .query_one(
            member_query(user_id, resource_id(team_id)?)
                .column((members::Entity, members::Column::Role)),
        )
        .await?
        .map(|row| row.try_get::<String>("", "role"))
        .transpose()?
        .map(|role| role.parse())
        .transpose()?;
    Ok(TeamPolicy::new(role))
}
fn member_query(user_id: &str, team_id: i64) -> sea_orm::sea_query::SelectStatement {
    Query::select()
        .from(members::Entity)
        .join(
            JoinType::InnerJoin,
            users::Entity,
            Expr::col((users::Entity, users::Column::Id))
                .eq(Expr::col((members::Entity, members::Column::UserId))),
        )
        .and_where(members::Column::TeamId.eq(team_id))
        .and_where(members::Column::UserId.eq(user_id))
        .and_where(users::Column::EmailVerified.eq(true))
        .and_where(users::Column::Disabled.eq(false))
        .to_owned()
}
