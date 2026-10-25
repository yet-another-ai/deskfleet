use crate::{
    ControlStore, Error, MachineAuth, Result, name, now_ms, one, resource_id, secret, secret_hash,
    sql, timestamp,
};
use deskfleet_protocol::control::Machine;
use sea_orm::{ConnectionTrait, QueryResult};
use serde_json::Value;

fn machine(row: QueryResult) -> Result<Machine> {
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
        self.team_role(user_id, team_id).await?;
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
        let m = self.machine(id).await?;
        self.team_role(user_id, &m.team_id).await?;
        Ok(m)
    }
    pub async fn machines(&self, user_id: &str, team_id: &str) -> Result<Vec<Machine>> {
        self.team_role(user_id, team_id).await?;
        self.db
            .query_all_raw(sql(
                "SELECT * FROM cp_machines WHERE team_id=$1 AND NOT revoked ORDER BY id",
                vec![resource_id(team_id)?.into()],
            ))
            .await?
            .into_iter()
            .map(machine)
            .collect()
    }
    /// Every Team member can rename a machine; the daemon keeps its own hostname.
    pub async fn rename_machine(&self, user_id: &str, id: &str, value: &str) -> Result<Machine> {
        let mut m = self.machine(id).await?;
        self.team_role(user_id, &m.team_id).await?;
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
        let m = self.machine(id).await?;
        self.require_admin(user_id, &m.team_id).await?;
        self.db
            .execute_raw(sql(
                "UPDATE cp_machines SET revoked=TRUE WHERE id=$1",
                vec![resource_id(id)?.into()],
            ))
            .await?;
        Ok(())
    }
}
