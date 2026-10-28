use crate::{ControlStore, Error, Result, json_rows, now_ms, one, resource_id, sql, timestamp};
use sea_orm::ConnectionTrait;

mod sync;
use serde_json::{Value, json};

impl ControlStore {
    pub async fn save_catalog(
        &self,
        machine_id: &str,
        snapshot: Value,
        providers: Value,
    ) -> Result<()> {
        self.db.execute_raw(sql("INSERT INTO cp_catalogs(machine_id,snapshot,providers,observed_at) VALUES($1,$2,$3,$4) ON CONFLICT(machine_id) DO UPDATE SET snapshot=excluded.snapshot,providers=excluded.providers,observed_at=excluded.observed_at",vec![resource_id(machine_id)?.into(),snapshot.into(),providers.into(),now_ms().into()])).await?;
        Ok(())
    }
    pub async fn catalog(&self, machine_id: &str) -> Result<Value> {
        let row = one(
            &self.db,
            "SELECT snapshot,providers,observed_at FROM cp_catalogs WHERE machine_id=$1",
            vec![resource_id(machine_id)?.into()],
        )
        .await?;
        Ok(
            json!({"machineId":machine_id,"snapshot":row.try_get::<Value>("","snapshot")?,"providers":row.try_get::<Value>("","providers")?,"lastObservedAt":timestamp(row.try_get("","observed_at")?)}),
        )
    }
    pub async fn sessions(
        &self,
        machine_id: &str,
        after: i64,
        limit: u32,
        archive: &str,
    ) -> Result<Value> {
        validate_page(after, limit)?;
        if !matches!(archive, "all" | "active" | "archiving" | "archived") {
            return Err(Error::Invalid("invalid archive state filter"));
        }
        let machine = resource_id(machine_id)?;
        let rows = if archive == "all" {
            json_rows(&self.db, "SELECT summary AS record FROM cp_sessions WHERE machine_id=$1 AND session_id::bigint>$2 ORDER BY session_id::bigint LIMIT $3", vec![machine.into(), after.into(), i64::from(limit+1).into()]).await?
        } else {
            json_rows(&self.db, "SELECT summary AS record FROM cp_sessions WHERE machine_id=$1 AND summary#>>'{session,archiveState}'=$2 AND session_id::bigint>$3 ORDER BY session_id::bigint LIMIT $4", vec![machine.into(), archive.into(), after.into(), i64::from(limit+1).into()]).await?
        };
        Ok(page(rows, limit, "sessions", "/session/id"))
    }
    pub async fn session_summary(&self, machine_id: &str, session_id: &str) -> Result<Value> {
        let rows = json_rows(
            &self.db,
            "SELECT summary AS record FROM cp_sessions WHERE machine_id=$1 AND session_id=$2",
            vec![resource_id(machine_id)?.into(), session_id.into()],
        )
        .await?;
        Ok(json!({"sessions": rows}))
    }
    pub async fn session_snapshot(&self, machine_id: &str, session_id: &str) -> Result<Value> {
        let row=one(&self.db,"SELECT snapshot,event_seq,observed_at FROM cp_sessions WHERE machine_id=$1 AND session_id=$2",vec![resource_id(machine_id)?.into(),session_id.into()]).await?;
        Ok(
            json!({"snapshot":row.try_get::<Value>("","snapshot")?,"lastEventSeq":row.try_get::<i64>("","event_seq")?.to_string(),"lastObservedAt":timestamp(row.try_get("","observed_at")?)}),
        )
    }
    pub async fn events(
        &self,
        machine_id: &str,
        session_id: &str,
        after: i64,
        limit: u32,
    ) -> Result<Value> {
        if after < 0 || limit == 0 || limit > 1000 {
            return Err(Error::Invalid("invalid history cursor or limit"));
        }
        let watermark: i64 = one(
            &self.db,
            "SELECT event_seq FROM cp_sessions WHERE machine_id=$1 AND session_id=$2",
            vec![resource_id(machine_id)?.into(), session_id.into()],
        )
        .await?
        .try_get("", "event_seq")?;
        let events=json_rows(&self.db,"SELECT record FROM cp_events WHERE machine_id=$1 AND session_id=$2 AND seq>$3 ORDER BY seq LIMIT $4",vec![resource_id(machine_id)?.into(),session_id.into(),after.into(),i64::from(limit).into()]).await?;
        Ok(json!({"events":events,"lastEventSeq":watermark.to_string()}))
    }
    pub async fn commands(
        &self,
        machine_id: &str,
        session_id: &str,
        after: i64,
        limit: u32,
    ) -> Result<Value> {
        validate_page(after, limit)?;
        let rows=json_rows(&self.db,"SELECT record FROM cp_commands WHERE machine_id=$1 AND record->>'sessionId'=$2 AND command_id::bigint>$3 ORDER BY command_id::bigint LIMIT $4",vec![resource_id(machine_id)?.into(),session_id.into(),after.into(),i64::from(limit+1).into()]).await?;
        Ok(page(rows, limit, "commands", "/id"))
    }
}
impl ControlStore {
    pub async fn command_by_operation(&self, machine_id: &str, operation: &str) -> Result<Value> {
        let row=one(&self.db,"SELECT record FROM cp_commands WHERE machine_id=$1 AND record->>'operationId'=$2 AND record->>'isCanonical'='true' LIMIT 1",vec![resource_id(machine_id)?.into(),operation.into()]).await?;
        Ok(row.try_get("", "record")?)
    }
}

fn validate_page(after: i64, limit: u32) -> Result<()> {
    if after < 0 || limit == 0 || limit > 1000 {
        return Err(Error::Invalid("invalid cursor or limit"));
    }
    Ok(())
}
fn page(mut rows: Vec<Value>, limit: u32, key: &str, id_path: &str) -> Value {
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let cursor = has_more
        .then(|| rows.last().and_then(|row| row.pointer(id_path)).cloned())
        .flatten();
    let mut result = json!({key:rows});
    if let Some(cursor) = cursor {
        result["nextCursor"] = cursor;
    }
    result
}
