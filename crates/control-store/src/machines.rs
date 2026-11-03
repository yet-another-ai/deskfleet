use crate::entities::{cp_machine_registrations as registrations, cp_machines as identities};
use crate::policies::{MachineAction, MachinePolicy, MachineScope, TeamAction, authorize};
use crate::{
    ControlStore, Error, MachineAuth, Result, name, now_ms, one_query, resource_id, secret,
    secret_hash, timestamp,
};
use deskfleet_protocol::control::Machine;
use sea_orm::sea_query::{Expr, ExprTrait, LockType, OnConflict, Query};
use sea_orm::{ConnectionTrait, QueryResult, TransactionTrait};
use serde_json::Value;

/// A Team-scoped registration. `id` is internal; `machine_id` is the public identity.
#[derive(Clone, Debug)]
pub struct MachineRegistration {
    pub id: String,
    pub machine_id: String,
    pub team_id: String,
    pub name: String,
    pub origin_id: String,
    pub local_machine_id: String,
    pub capabilities: Value,
    pub online: bool,
    pub last_seen_at: Option<String>,
}

impl MachineRegistration {
    pub fn public(&self) -> Machine {
        self.clone().into_public()
    }
    pub fn into_public(self) -> Machine {
        Machine {
            id: self.machine_id,
            team_id: self.team_id,
            name: self.name,
            origin_id: self.origin_id,
            local_machine_id: self.local_machine_id,
            capabilities: self.capabilities,
            online: self.online,
            last_seen_at: self.last_seen_at,
        }
    }
}

pub(crate) fn machine(row: QueryResult) -> Result<MachineRegistration> {
    Ok(MachineRegistration {
        id: row.try_get::<i64>("", "id")?.to_string(),
        machine_id: row.try_get::<i64>("", "machine_id")?.to_string(),
        team_id: row.try_get::<i64>("", "team_id")?.to_string(),
        name: row.try_get("", "name")?,
        origin_id: row.try_get("", "origin_id")?,
        local_machine_id: row.try_get("", "local_machine_id")?,
        capabilities: row.try_get("", "capabilities")?,
        online: false,
        last_seen_at: row
            .try_get::<Option<i64>>("", "last_seen_at")?
            .map(timestamp),
    })
}
impl ControlStore {
    #[allow(clippy::too_many_arguments)]
    pub async fn enroll(
        &self,
        user_id: &str,
        team_id: &str,
        machine_name: &str,
        origin: &str,
        local_id: &str,
        capabilities: Value,
        identity_token: &str,
    ) -> Result<(MachineRegistration, String)> {
        if identity_token.trim().is_empty() || identity_token.len() > 512 {
            return Err(Error::Invalid("invalid machine identity token"));
        }
        uuid::Uuid::parse_str(origin).map_err(|_| Error::Invalid("invalid catalog origin UUID"))?;
        resource_id(local_id)?;
        let token = secret();
        let tx = self.db.begin().await?;
        authorize(
            &crate::teams::lock_team_policy(&tx, user_id, team_id).await?,
            TeamAction::EnrollMachine,
        )?;
        let identity = one_query(
            &tx,
            Query::insert()
                .into_table(identities::Entity)
                .columns([identities::Column::IdentityTokenHash])
                .values_panic([secret_hash(identity_token).into()])
                .on_conflict(
                    OnConflict::column(identities::Column::IdentityTokenHash)
                        .update_column(identities::Column::IdentityTokenHash)
                        .to_owned(),
                )
                .returning_col(identities::Column::Id),
        )
        .await?
        .try_get::<i64>("", "id")?;
        let existing = tx
            .query_one(
                Query::select()
                    .from(registrations::Entity)
                    .column(sea_orm::sea_query::Asterisk)
                    .and_where(Expr::col(registrations::Column::MachineId).eq(identity))
                    .and_where(Expr::col(registrations::Column::TeamId).eq(resource_id(team_id)?))
                    .lock(LockType::Update),
            )
            .await?;
        let row = if let Some(existing) = existing {
            if !existing.try_get::<bool>("", "revoked")? {
                return Err(Error::Conflict(
                    "machine is already registered in this team",
                ));
            }
            if existing.try_get::<String>("", "origin_id")? != origin
                || existing.try_get::<String>("", "local_machine_id")? != local_id
            {
                return Err(Error::Conflict(
                    "registration must retain its catalog identity",
                ));
            }
            self.check_registration_capacity(
                &tx,
                resource_id(team_id)?,
                existing.try_get("", "id")?,
            )
            .await?;
            one_query(
                &tx,
                Query::update()
                    .table(registrations::Entity)
                    .value(registrations::Column::Revoked, false)
                    .value(registrations::Column::TokenHash, secret_hash(&token))
                    .value(registrations::Column::OwnerId, user_id)
                    .value(registrations::Column::Name, name(machine_name)?)
                    .value(registrations::Column::Capabilities, capabilities)
                    .and_where(
                        Expr::col(registrations::Column::Id).eq(existing.try_get::<i64>("", "id")?),
                    )
                    .returning_all(),
            )
            .await?
        } else {
            tx.query_one(
                Query::insert()
                    .into_table(registrations::Entity)
                    .columns([
                        registrations::Column::MachineId,
                        registrations::Column::TeamId,
                        registrations::Column::OwnerId,
                        registrations::Column::Name,
                        registrations::Column::OriginId,
                        registrations::Column::LocalMachineId,
                        registrations::Column::TokenHash,
                        registrations::Column::Capabilities,
                    ])
                    .values_panic([
                        identity.into(),
                        resource_id(team_id)?.into(),
                        user_id.into(),
                        name(machine_name)?.into(),
                        origin.into(),
                        local_id.into(),
                        secret_hash(&token).into(),
                        capabilities.into(),
                    ])
                    .on_conflict(
                        OnConflict::column(registrations::Column::OriginId)
                            .do_nothing()
                            .to_owned(),
                    )
                    .returning_all(),
            )
            .await?
            .ok_or(Error::Conflict("machine origin is already registered"))?
        };
        tx.commit().await?;
        Ok((machine(row)?, token))
    }
    pub async fn authenticate_machine(&self, token: &str) -> Result<MachineAuth> {
        let row = self
            .db
            .query_one(
                Query::select()
                    .from(registrations::Entity)
                    .column(sea_orm::sea_query::Asterisk)
                    .and_where(Expr::col(registrations::Column::TokenHash).eq(secret_hash(token)))
                    .and_where(Expr::col(registrations::Column::Revoked).not()),
            )
            .await?
            .ok_or(Error::Unauthorized)?;
        Ok(MachineAuth {
            machine: machine(row)?,
        })
    }
    pub async fn machine(&self, id: &str) -> Result<MachineRegistration> {
        machine(
            one_query(
                &self.db,
                Query::select()
                    .from(registrations::Entity)
                    .column(sea_orm::sea_query::Asterisk)
                    .and_where(Expr::col(registrations::Column::Id).eq(resource_id(id)?))
                    .and_where(Expr::col(registrations::Column::Revoked).not()),
            )
            .await?,
        )
    }
    /// Resolve the public Machine identity within an authorized Team.
    pub async fn authorized_registration(
        &self,
        user_id: &str,
        team_id: &str,
        machine_id: &str,
    ) -> Result<MachineRegistration> {
        self.authorize_registration(user_id, team_id, machine_id, MachineAction::Read)
            .await
    }

    pub async fn authorize_registration(
        &self,
        user_id: &str,
        team_id: &str,
        machine_id: &str,
        action: MachineAction,
    ) -> Result<MachineRegistration> {
        let membership = self.team_policy(user_id, team_id).await?;
        authorize(&MachinePolicy::new(membership.role()), action)?;
        machine(
            one_query(
                &self.db,
                Query::select()
                    .from(registrations::Entity)
                    .column(sea_orm::sea_query::Asterisk)
                    .and_where(
                        Expr::col(registrations::Column::MachineId).eq(resource_id(machine_id)?),
                    )
                    .and_where(Expr::col(registrations::Column::TeamId).eq(resource_id(team_id)?))
                    .and_where(Expr::col(registrations::Column::Revoked).not()),
            )
            .await?,
        )
    }

    pub async fn authorized_machine(&self, user_id: &str, id: &str) -> Result<MachineRegistration> {
        self.authorize_machine(user_id, id, MachineAction::Read)
            .await
    }
    /// Authorize an action using membership in the Machine's actual Team.
    ///
    /// # Errors
    /// Returns an error for denied actions, missing/revoked machines, or database failures.
    pub async fn authorize_machine(
        &self,
        user_id: &str,
        id: &str,
        action: MachineAction,
    ) -> Result<MachineRegistration> {
        let m = self.machine(id).await?;
        let membership = self.team_policy(user_id, &m.team_id).await?;
        authorize(&MachinePolicy::new(membership.role()), action)?;
        Ok(m)
    }
    pub async fn machines(&self, user_id: &str, team_id: &str) -> Result<Vec<MachineRegistration>> {
        MachineScope::new(user_id, team_id).resolve(self).await
    }
    /// Every Team member can rename a machine; the daemon keeps its own hostname.
    pub async fn rename_machine(
        &self,
        user_id: &str,
        id: &str,
        value: &str,
    ) -> Result<MachineRegistration> {
        let mut m = self.machine(id).await?;
        let value = name(value)?;
        let tx = self.db.begin().await?;
        let membership = crate::teams::lock_team_policy(&tx, user_id, &m.team_id).await?;
        authorize(
            &MachinePolicy::new(membership.role()),
            MachineAction::Rename,
        )?;
        let changed = tx
            .execute(
                Query::update()
                    .table(registrations::Entity)
                    .value(registrations::Column::Name, value)
                    .and_where(Expr::col(registrations::Column::Id).eq(resource_id(id)?))
                    .and_where(Expr::col(registrations::Column::Revoked).not()),
            )
            .await?;
        if changed.rows_affected() != 1 {
            return Err(Error::NotFound);
        }
        tx.commit().await?;
        m.name = value.to_owned();
        Ok(m)
    }
    pub async fn set_machine_capabilities(&self, id: &str, capabilities: Value) -> Result<()> {
        if !capabilities.is_object() {
            return Err(Error::Invalid("invalid machine capabilities"));
        }
        self.db
            .execute(
                Query::update()
                    .table(registrations::Entity)
                    .value(registrations::Column::Capabilities, capabilities)
                    .and_where(Expr::col(registrations::Column::Id).eq(resource_id(id)?))
                    .and_where(Expr::col(registrations::Column::Revoked).not()),
            )
            .await?;
        Ok(())
    }
    pub async fn machine_seen(&self, id: &str) -> Result<()> {
        self.db
            .execute(
                Query::update()
                    .table(registrations::Entity)
                    .value(registrations::Column::LastSeenAt, now_ms())
                    .and_where(Expr::col(registrations::Column::Id).eq(resource_id(id)?))
                    .and_where(Expr::col(registrations::Column::Revoked).not()),
            )
            .await?;
        Ok(())
    }
    pub async fn revoke_machine(&self, user_id: &str, id: &str) -> Result<()> {
        let m = self.machine(id).await?;
        let tx = self.db.begin().await?;
        let membership = crate::teams::lock_team_policy(&tx, user_id, &m.team_id).await?;
        authorize(
            &MachinePolicy::new(membership.role()),
            MachineAction::Remove,
        )?;
        // Lock the registration after its Team, matching admission order.
        tx.execute(
            Query::update()
                .table(registrations::Entity)
                .value(registrations::Column::Revoked, true)
                .and_where(Expr::col(registrations::Column::Id).eq(resource_id(id)?)),
        )
        .await?;
        // Preserve durable admission outcomes for reactivation. Revoked registrations
        // are excluded from Team capacity until they are admitted again.
        tx.commit().await?;
        Ok(())
    }
}
