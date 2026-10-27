use crate::policies::{MachineAction, MachinePolicy, MachineScope, TeamAction, authorize};
use crate::{
    ControlStore, Error, MachineAuth, Result, name, now_ms, one, resource_id, secret, secret_hash,
    sql, timestamp,
};
use deskfleet_protocol::control::Machine;
use sea_orm::{ConnectionTrait, QueryResult, TransactionTrait};
use serde_json::Value;

pub(crate) fn machine(row: QueryResult) -> Result<Machine> {
    Ok(Machine {
        id: row.try_get::<i64>("", "id")?.to_string(),
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
    pub async fn enroll(
        &self,
        user_id: &str,
        team_id: &str,
        machine_name: &str,
        origin: &str,
        local_id: &str,
        capabilities: Value,
    ) -> Result<(Machine, String)> {
        self.authorize_team(user_id, team_id, TeamAction::EnrollMachine)
            .await?;
        uuid::Uuid::parse_str(origin).map_err(|_| Error::Invalid("invalid catalog origin UUID"))?;
        resource_id(local_id)?;
        let token = secret();
        let row = self.db.query_one_raw(sql(
            "INSERT INTO cp_machines(team_id,owner_id,name,origin_id,local_machine_id,token_hash,capabilities) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(origin_id) DO NOTHING RETURNING *",
            vec![resource_id(team_id)?.into(),user_id.into(),name(machine_name)?.into(),origin.into(),local_id.into(),secret_hash(&token).into(),capabilities.into()],
        )).await?.ok_or(Error::Conflict("machine origin is already registered"))?;
        Ok((machine(row)?, token))
    }
    pub async fn authenticate_machine(&self, token: &str) -> Result<MachineAuth> {
        let row = self
            .db
            .query_one_raw(sql(
                "SELECT * FROM cp_machines WHERE token_hash=$1 AND NOT revoked",
                vec![secret_hash(token).into()],
            ))
            .await?
            .ok_or(Error::Unauthorized)?;
        Ok(MachineAuth {
            machine: machine(row)?,
        })
    }
    pub async fn machine(&self, id: &str) -> Result<Machine> {
        machine(
            one(
                &self.db,
                "SELECT * FROM cp_machines WHERE id=$1 AND NOT revoked",
                vec![resource_id(id)?.into()],
            )
            .await?,
        )
    }
    pub async fn authorized_machine(&self, user_id: &str, id: &str) -> Result<Machine> {
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
    ) -> Result<Machine> {
        let m = self.machine(id).await?;
        let membership = self.team_policy(user_id, &m.team_id).await?;
        authorize(&MachinePolicy::new(membership.role()), action)?;
        Ok(m)
    }
    pub async fn machines(&self, user_id: &str, team_id: &str) -> Result<Vec<Machine>> {
        MachineScope::new(user_id, team_id).resolve(self).await
    }
    /// Every Team member can rename a machine; the daemon keeps its own hostname.
    pub async fn rename_machine(&self, user_id: &str, id: &str, value: &str) -> Result<Machine> {
        let mut m = self
            .authorize_machine(user_id, id, MachineAction::Rename)
            .await?;
        let value = name(value)?;
        self.db
            .execute_raw(sql(
                "UPDATE cp_machines SET name=$1 WHERE id=$2 AND NOT revoked",
                vec![value.into(), resource_id(id)?.into()],
            ))
            .await?;
        m.name = value.to_owned();
        Ok(m)
    }
    pub async fn set_machine_capabilities(&self, id: &str, capabilities: Value) -> Result<()> {
        if !capabilities.is_object() {
            return Err(Error::Invalid("invalid machine capabilities"));
        }
        self.db
            .execute_raw(sql(
                "UPDATE cp_machines SET capabilities=$1 WHERE id=$2 AND NOT revoked",
                vec![capabilities.into(), resource_id(id)?.into()],
            ))
            .await?;
        Ok(())
    }
    pub async fn machine_seen(&self, id: &str) -> Result<()> {
        self.db
            .execute_raw(sql(
                "UPDATE cp_machines SET last_seen_at=$1 WHERE id=$2 AND NOT revoked",
                vec![now_ms().into(), resource_id(id)?.into()],
            ))
            .await?;
        Ok(())
    }
    pub async fn revoke_machine(&self, user_id: &str, id: &str) -> Result<()> {
        self.authorize_machine(user_id, id, MachineAction::Remove)
            .await?;
        let tx = self.db.begin().await?;
        // Lock the Machine before releasing reservations, matching admission order.
        tx.execute_raw(sql(
            "UPDATE cp_machines SET revoked=TRUE WHERE id=$1",
            vec![resource_id(id)?.into()],
        ))
        .await?;
        tx.execute_raw(sql(
            "UPDATE cp_session_admissions SET status='released' WHERE machine_id=$1",
            vec![resource_id(id)?.into()],
        ))
        .await?;
        tx.commit().await?;
        Ok(())
    }
}
