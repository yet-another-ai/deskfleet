use crate::{ControlStore, Error, Result, json_rows, now_ms, one, resource_id, sql, timestamp};
use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::{Value, json};

fn sequence(value: &Value) -> Result<i64> {
    value
        .as_str()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n >= 0)
        .ok_or(Error::Invalid("invalid history sequence"))
}
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
    pub async fn sync_history(
        &self,
        machine_id: &str,
        session_id: &str,
        snapshot: Value,
        events: Vec<Value>,
        commands: Vec<Value>,
    ) -> Result<String> {
        resource_id(session_id)?;
        if snapshot.pointer("/session/id").and_then(Value::as_str) != Some(session_id) {
            return Err(Error::Invalid("snapshot session does not match target"));
        }
        if events.len() > 1000 {
            return Err(Error::Invalid("history batch exceeds 1000 events"));
        }
        let snapshot_seq = sequence(&snapshot["session"]["lastEventSeq"])?;
        let machine = resource_id(machine_id)?;
        let tx = self.db.begin().await?;
        tx.execute_raw(sql("INSERT INTO cp_sessions(machine_id,session_id,snapshot,snapshot_seq,observed_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(machine_id,session_id) DO NOTHING",vec![machine.into(),session_id.into(),snapshot.clone().into(),snapshot_seq.into(),now_ms().into()])).await?;
        let row=one(&tx,"SELECT event_seq,snapshot_seq FROM cp_sessions WHERE machine_id=$1 AND session_id=$2 FOR UPDATE",vec![machine.into(),session_id.into()]).await?;
        let mut watermark = row.try_get::<i64>("", "event_seq")?;
        let current_snapshot_seq = row.try_get::<i64>("", "snapshot_seq")?;
        for event in events {
            if event["sessionId"].as_str() != Some(session_id) {
                return Err(Error::Invalid("event session does not match target"));
            }
            let seq = sequence(&event["seq"])?;
            if seq <= 0 || seq > snapshot_seq {
                return Err(Error::Invalid("event exceeds snapshot watermark"));
            }
            if let Some(previous) = tx
                .query_one_raw(sql(
                    "SELECT record FROM cp_events WHERE machine_id=$1 AND session_id=$2 AND seq=$3",
                    vec![machine.into(), session_id.into(), seq.into()],
                ))
                .await?
            {
                if previous.try_get::<Value>("", "record")? != event {
                    return Err(Error::Conflict(
                        "event sequence already has different content",
                    ));
                }
                continue;
            }
            if seq != watermark + 1 {
                return Err(Error::Conflict("history event gap"));
            }
            tx.execute_raw(sql(
                "INSERT INTO cp_events VALUES($1,$2,$3,$4)",
                vec![machine.into(), session_id.into(), seq.into(), event.into()],
            ))
            .await?;
            watermark = seq;
        }
        for command in commands
            .into_iter()
            .filter(|_| snapshot_seq >= current_snapshot_seq)
        {
            let id = command["id"]
                .as_str()
                .ok_or(Error::Invalid("command id missing"))?
                .to_owned();
            resource_id(&id)?;
            if command["sessionId"]
                .as_str()
                .is_some_and(|id| id != session_id)
            {
                return Err(Error::Invalid("command session does not match target"));
            }
            tx.execute_raw(sql("INSERT INTO cp_commands VALUES($1,$2,$3) ON CONFLICT(machine_id,command_id) DO UPDATE SET record=excluded.record",vec![machine.into(),id.into(),command.into()])).await?;
        }
        if snapshot_seq >= current_snapshot_seq {
            tx.execute_raw(sql("UPDATE cp_sessions SET snapshot=$1,snapshot_seq=$2,event_seq=$3,observed_at=$4 WHERE machine_id=$5 AND session_id=$6",vec![snapshot.into(),snapshot_seq.into(),watermark.into(),now_ms().into(),machine.into(),session_id.into()])).await?;
        } else {
            tx.execute_raw(sql("UPDATE cp_sessions SET event_seq=$1,observed_at=$2 WHERE machine_id=$3 AND session_id=$4",vec![watermark.into(),now_ms().into(),machine.into(),session_id.into()])).await?;
        }
        tx.commit().await?;
        Ok(watermark.to_string())
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
        let rows = json_rows(&self.db, "SELECT snapshot AS record FROM cp_sessions WHERE machine_id=$1 AND session_id::bigint>$2 AND ($3='all' OR snapshot#>>'{session,archiveState}'=$3) ORDER BY session_id::bigint LIMIT $4",vec![resource_id(machine_id)?.into(),after.into(),archive.into(),i64::from(limit+1).into()]).await?;
        Ok(page(rows, limit, "sessions", "/session/id"))
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
        let snapshot = self.session_snapshot(machine_id, session_id).await?;
        let events=json_rows(&self.db,"SELECT record FROM cp_events WHERE machine_id=$1 AND session_id=$2 AND seq>$3 ORDER BY seq LIMIT $4",vec![resource_id(machine_id)?.into(),session_id.into(),after.into(),i64::from(limit).into()]).await?;
        Ok(json!({"events":events,"lastEventSeq":snapshot["lastEventSeq"]}))
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
