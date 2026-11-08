use super::credentials::{credential_mutation, revoke};
use super::lock_authentication_generation;
use crate::entities::{
    cp_account_deletion_requests as requests, cp_github_app_authorizations as github_app,
    cp_github_identities as github, cp_google_identities as google,
    cp_identity_challenges as challenges, cp_invites as invites, cp_login_codes as codes,
    cp_machine_registrations as registrations, cp_members as members, cp_passkeys as passkeys,
    cp_site_admins as admins, cp_site_audit as audit, cp_users as users,
};
use crate::{ControlStore, Error, Result, now_ms, resource_id, timestamp};
use deskfleet_protocol::control::PeerAuthorization;
use sea_orm::sea_query::{Expr, ExprTrait, Order, Query};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set,
    TransactionTrait,
};
use serde_json::{Value, json};

fn validate_reason(value: &str) -> Result<&str> {
    let value = value.trim();
    if value.is_empty() || value.len() > 2000 {
        Err(Error::Invalid("reason must contain 1 to 2000 bytes"))
    } else {
        Ok(value)
    }
}

fn review_note(value: Option<&str>) -> Result<Option<String>> {
    let value = value.map(str::trim).filter(|value| !value.is_empty());
    if value.is_some_and(|value| value.len() > 2000) {
        return Err(Error::Invalid(
            "review note must contain at most 2000 bytes",
        ));
    }
    Ok(value.map(str::to_owned))
}

fn request_value(row: &requests::Model) -> Value {
    json!({
        "id": row.id.to_string(),
        "reason": row.reason,
        "status": row.status,
        "requestedAt": timestamp(row.requested_at),
        "reviewedAt": row.reviewed_at.map(timestamp),
        "reviewNote": row.review_note,
    })
}

impl ControlStore {
    /// The newest request is what the account security page shows, including a
    /// rejection note that allows the user to decide whether to ask again.
    pub async fn account_deletion_request(&self, user_id: &str) -> Result<Option<Value>> {
        Ok(requests::Entity::find()
            .filter(requests::Column::UserId.eq(user_id))
            .order_by_desc(requests::Column::Id)
            .one(&self.db)
            .await?
            .map(|row| request_value(&row)))
    }

    pub async fn request_account_deletion(&self, user_id: &str, reason: &str) -> Result<Value> {
        let reason = validate_reason(reason)?;
        let tx = self.db.begin().await?;
        lock_authentication_generation(&tx).await?;
        users::Entity::find_by_id(user_id)
            .filter(users::Column::Disabled.eq(false))
            .filter(users::Column::DeletedAt.is_null())
            .lock_exclusive()
            .select_only()
            .column(users::Column::Id)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::Unauthorized)?;
        if requests::Entity::find()
            .filter(requests::Column::UserId.eq(user_id))
            .filter(requests::Column::Status.eq("pending"))
            .one(&tx)
            .await?
            .is_some()
        {
            return Err(Error::Conflict(
                "an account deletion request is already pending",
            ));
        }
        let row = requests::Entity::insert(requests::ActiveModel {
            user_id: Set(user_id.into()),
            reason: Set(reason.into()),
            status: Set("pending".into()),
            requested_at: Set(now_ms()),
            ..Default::default()
        })
        .exec_with_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(request_value(&row))
    }

    /// Cancelling is allowed while the request is pending. The row remains for
    /// the user's history instead of being deleted.
    pub async fn cancel_account_deletion(&self, user_id: &str) -> Result<()> {
        let tx = self.db.begin().await?;
        lock_authentication_generation(&tx).await?;
        users::Entity::find_by_id(user_id)
            .filter(users::Column::Disabled.eq(false))
            .filter(users::Column::DeletedAt.is_null())
            .lock_exclusive()
            .select_only()
            .column(users::Column::Id)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::Unauthorized)?;
        let changed = requests::Entity::update_many()
            .col_expr(requests::Column::Status, Expr::val("cancelled"))
            .col_expr(requests::Column::ReviewedAt, Expr::val(now_ms()))
            .filter(requests::Column::UserId.eq(user_id))
            .filter(requests::Column::Status.eq("pending"))
            .exec(&tx)
            .await?;
        if changed.rows_affected != 1 {
            return Err(Error::NotFound);
        }
        tx.commit().await?;
        Ok(())
    }

    /// Pending requests are returned oldest first so the operator can work
    /// through the queue with a stable cursor.
    pub async fn account_deletion_requests(
        &self,
        actor: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<Value> {
        if !self.is_site_admin(actor).await? {
            return Err(Error::Forbidden);
        }
        let after = cursor.map(resource_id).transpose()?.unwrap_or(0);
        let limit = limit.clamp(1, 100);
        let query = Query::select()
            .expr_as(
                Expr::col((requests::Entity, requests::Column::Id)),
                "request_id",
            )
            .expr_as(
                Expr::col((requests::Entity, requests::Column::Reason)),
                "request_reason",
            )
            .expr_as(
                Expr::col((requests::Entity, requests::Column::Status)),
                "request_status",
            )
            .expr_as(
                Expr::col((requests::Entity, requests::Column::RequestedAt)),
                "requested_at",
            )
            .expr_as(Expr::col((users::Entity, users::Column::Id)), "user_id")
            .expr_as(Expr::col((users::Entity, users::Column::Name)), "user_name")
            .expr_as(
                Expr::col((users::Entity, users::Column::Email)),
                "user_email",
            )
            .from(requests::Entity)
            .join(
                sea_orm::JoinType::InnerJoin,
                users::Entity,
                Expr::col((users::Entity, users::Column::Id))
                    .eq(Expr::col((requests::Entity, requests::Column::UserId))),
            )
            .and_where(requests::Column::Status.eq("pending"))
            .and_where(Expr::col((requests::Entity, requests::Column::Id)).gt(after))
            .order_by((requests::Entity, requests::Column::Id), Order::Asc)
            .limit((limit + 1) as u64)
            .to_owned();
        let mut rows = self.db.query_all(&query).await?;
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        let next_cursor = if has_more {
            rows.last()
                .map(|row| row.try_get::<i64>("", "request_id"))
                .transpose()?
                .map(|id| id.to_string())
        } else {
            None
        };
        let page = rows
            .into_iter()
            .map(|row| {
                Ok(json!({
                    "id": row.try_get::<i64>("", "request_id")?.to_string(),
                    "reason": row.try_get::<String>("", "request_reason")?,
                    "status": row.try_get::<String>("", "request_status")?,
                    "requestedAt": timestamp(row.try_get::<i64>("", "requested_at")?),
                    "user": {
                        "id": row.try_get::<String>("", "user_id")?,
                        "name": row.try_get::<String>("", "user_name")?,
                        "email": row.try_get::<String>("", "user_email")?,
                    },
                }))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({"requests": page, "nextCursor": next_cursor}))
    }

    /// Approving closes the account by anonymizing the retained identity row,
    /// disabling sign-in, revoking credentials, and removing Team membership.
    /// Team ownership is intentionally not transferable through this action.
    pub async fn review_account_deletion(
        &self,
        actor: &str,
        request_id: &str,
        approve: bool,
        note: Option<&str>,
    ) -> Result<(String, Vec<PeerAuthorization>)> {
        let id = resource_id(request_id)?;
        let note = review_note(note)?;
        let tx = self.db.begin().await?;
        admins::Entity::find_by_id(actor)
            .lock_shared()
            .select_only()
            .column(admins::Column::UserId)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::Forbidden)?;
        let target = requests::Entity::find_by_id(id)
            .select_only()
            .column(requests::Column::UserId)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        let user = users::Entity::find_by_id(&target)
            .lock_exclusive()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        if user.deleted_at.is_some() {
            return Err(Error::Conflict("account is already deleted"));
        }
        let request = requests::Entity::find_by_id(id)
            .filter(requests::Column::Status.eq("pending"))
            .filter(requests::Column::UserId.eq(&target))
            .lock_exclusive()
            .one(&tx)
            .await?
            .ok_or(Error::Conflict(
                "account deletion request is no longer pending",
            ))?;
        if actor == target {
            return Err(Error::Conflict(
                "cannot review your own account deletion request",
            ));
        }
        let now = now_ms();
        if !approve {
            requests::Entity::update_many()
                .col_expr(requests::Column::Status, Expr::val("rejected"))
                .col_expr(requests::Column::ReviewedAt, Expr::val(now))
                .col_expr(requests::Column::ReviewedBy, Expr::val(actor))
                .col_expr(requests::Column::ReviewNote, Expr::val(note))
                .filter(requests::Column::Id.eq(id))
                .exec(&tx)
                .await?;
            audit::Entity::insert(audit::ActiveModel {
                actor_user_id: Set(Some(actor.into())),
                source: Set("user".into()),
                action: Set("account.deletion.reject".into()),
                target_user_id: Set(Some(target.clone())),
                before_value: Set(json!({"requestId":id,"status":request.status})),
                after_value: Set(json!({"requestId":id,"status":"rejected"})),
                occurred_at: Set(now),
                ..Default::default()
            })
            .exec_without_returning(&tx)
            .await?;
            tx.commit().await?;
            return Ok((target, Vec::new()));
        }
        if members::Entity::find()
            .filter(members::Column::UserId.eq(&target))
            .filter(members::Column::Role.eq("owner"))
            .one(&tx)
            .await?
            .is_some()
        {
            return Err(Error::Conflict(
                "transfer team ownership before deleting this account",
            ));
        }
        let previous_email = user.email;
        let changed = credential_mutation()
            .col_expr(users::Column::Name, Expr::val("Deleted account"))
            .col_expr(
                users::Column::Email,
                Expr::val(format!("deleted+{target}@invalid")),
            )
            .col_expr(users::Column::EmailVerified, Expr::val(false))
            .col_expr(
                users::Column::PasswordHash,
                Expr::val(Option::<String>::None),
            )
            .col_expr(users::Column::Disabled, Expr::val(true))
            .col_expr(users::Column::DeletedAt, Expr::val(now))
            .filter(users::Column::Id.eq(&target))
            .filter(users::Column::DeletedAt.is_null())
            .exec(&tx)
            .await?;
        if changed.rows_affected != 1 {
            return Err(Error::Conflict("account is already deleted"));
        }
        let peers = revoke(&tx, &target).await?;
        passkeys::Entity::delete_many()
            .filter(passkeys::Column::UserId.eq(&target))
            .exec(&tx)
            .await?;
        codes::Entity::delete_many()
            .filter(codes::Column::UserId.eq(&target))
            .exec(&tx)
            .await?;
        challenges::Entity::delete_many()
            .filter(challenges::Column::UserId.eq(&target))
            .exec(&tx)
            .await?;
        challenges::Entity::delete_many()
            .filter(challenges::Column::Email.eq(&previous_email))
            .exec(&tx)
            .await?;
        github::Entity::delete_many()
            .filter(github::Column::UserId.eq(&target))
            .exec(&tx)
            .await?;
        google::Entity::delete_many()
            .filter(google::Column::UserId.eq(&target))
            .exec(&tx)
            .await?;
        github_app::Entity::delete_many()
            .filter(github_app::Column::UserId.eq(&target))
            .exec(&tx)
            .await?;
        admins::Entity::delete_many()
            .filter(admins::Column::UserId.eq(&target))
            .exec(&tx)
            .await?;
        registrations::Entity::update_many()
            .col_expr(registrations::Column::Revoked, Expr::val(true))
            .filter(registrations::Column::OwnerId.eq(&target))
            .exec(&tx)
            .await?;
        members::Entity::delete_many()
            .filter(members::Column::UserId.eq(&target))
            .exec(&tx)
            .await?;
        invites::Entity::delete_many()
            .filter(invites::Column::Email.eq(&previous_email))
            .exec(&tx)
            .await?;
        requests::Entity::update_many()
            .col_expr(requests::Column::Status, Expr::val("approved"))
            .col_expr(requests::Column::ReviewedAt, Expr::val(now))
            .col_expr(requests::Column::ReviewedBy, Expr::val(actor))
            .col_expr(requests::Column::ReviewNote, Expr::val(note))
            .filter(requests::Column::Id.eq(id))
            .exec(&tx)
            .await?;
        audit::Entity::insert(audit::ActiveModel {
            actor_user_id: Set(Some(actor.into())),
            source: Set("user".into()),
            action: Set("account.delete".into()),
            target_user_id: Set(Some(target.clone())),
            before_value: Set(json!({"requestId":id,"status":request.status})),
            after_value: Set(json!({"requestId":id,"status":"approved","deletedAt":now})),
            occurred_at: Set(now),
            ..Default::default()
        })
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok((target, peers))
    }
}
