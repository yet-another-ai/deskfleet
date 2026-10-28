use std::collections::BTreeMap;

use crate::{ControlStore, Error, Result, now_ms, one, resource_id, sql};
use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::Value;

fn sequence(value: &Value) -> Result<i64> {
    value
        .as_str()
        .and_then(|s| s.parse().ok())
        .filter(|n| *n >= 0)
        .ok_or(Error::Invalid("invalid history sequence"))
}

impl ControlStore {
    pub async fn sync_history(
        &self,
        machine_id: &str,
        session_id: &str,
        snapshot: Value,
        events: Vec<Value>,
        commands: Vec<Value>,
    ) -> Result<String> {
        self.sync_history_batch(
            machine_id,
            session_id,
            Some(snapshot),
            None,
            events,
            commands,
        )
        .await
    }

    /// A snapshot is sent once per captured state. Subsequent bounded pages name
    /// that snapshot's watermark; a missing or older stored snapshot cannot ACK them.
    pub async fn sync_history_batch(
        &self,
        machine_id: &str,
        session_id: &str,
        snapshot: Option<Value>,
        snapshot_seq: Option<String>,
        events: Vec<Value>,
        commands: Vec<Value>,
    ) -> Result<String> {
        resource_id(session_id)?;
        let bound = if let Some(snapshot) = &snapshot {
            if snapshot.pointer("/session/id").and_then(Value::as_str) != Some(session_id) {
                return Err(Error::Invalid("snapshot session does not match target"));
            }
            sequence(&snapshot["session"]["lastEventSeq"])?
        } else {
            sequence(&snapshot_seq.map(Value::String).unwrap_or(Value::Null))?
        };
        if events.len() > 1000 || commands.len() > 1000 {
            return Err(Error::Invalid("history batch exceeds 1000 records"));
        }
        let mut event_sequences = Vec::with_capacity(events.len());
        for event in &events {
            if event["sessionId"].as_str() != Some(session_id) {
                return Err(Error::Invalid("event session does not match target"));
            }
            let seq = sequence(&event["seq"])?;
            if seq == 0 || seq > bound {
                return Err(Error::Invalid("event exceeds snapshot watermark"));
            }
            event_sequences.push(seq);
        }
        let machine = resource_id(machine_id)?;
        let tx = self.db.begin().await?;
        if let Some(snapshot) = &snapshot {
            tx.execute_raw(sql(
                "INSERT INTO cp_sessions(machine_id,session_id,snapshot,snapshot_seq,observed_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(machine_id,session_id) DO NOTHING",
                vec![machine.into(),session_id.into(),snapshot.clone().into(),bound.into(),now_ms().into()],
            )).await?;
        }
        let row = one(&tx, "SELECT event_seq,snapshot_seq FROM cp_sessions WHERE machine_id=$1 AND session_id=$2 FOR UPDATE", vec![machine.into(),session_id.into()]).await?;
        let mut watermark = row.try_get::<i64>("", "event_seq")?;
        let current_snapshot_seq = row.try_get::<i64>("", "snapshot_seq")?;
        if snapshot.is_none() && current_snapshot_seq < bound {
            return Err(Error::Conflict("history snapshot is missing"));
        }
        let mut previous = BTreeMap::new();
        if !events.is_empty() {
            for row in tx.query_all_raw(sql(
                "SELECT e.seq,e.record FROM cp_events e JOIN jsonb_array_elements($3::jsonb) AS incoming(record) ON e.seq=(incoming.record->>'seq')::bigint WHERE e.machine_id=$1 AND e.session_id=$2",
                vec![machine.into(),session_id.into(),Value::Array(events.clone()).into()],
            )).await? {
                previous.insert(row.try_get::<i64>("", "seq")?, row.try_get::<Value>("", "record")?);
            }
        }
        let mut insertions = Vec::new();
        for (seq, event) in event_sequences.into_iter().zip(events) {
            if let Some(existing) = previous.get(&seq) {
                if *existing != event {
                    return Err(Error::Conflict(
                        "event sequence already has different content",
                    ));
                }
                continue;
            }
            if seq != watermark + 1 {
                return Err(Error::Conflict("history event gap"));
            }
            previous.insert(seq, event.clone());
            insertions.push(event);
            watermark = seq;
        }
        if !insertions.is_empty() {
            tx.execute_raw(sql(
                "INSERT INTO cp_events(machine_id,session_id,seq,record) SELECT $1,$2,(event->>'seq')::bigint,event FROM jsonb_array_elements($3::jsonb) event",
                vec![machine.into(),session_id.into(),Value::Array(insertions).into()],
            )).await?;
        }
        if bound >= current_snapshot_seq && !commands.is_empty() {
            let mut unique = BTreeMap::new();
            for command in commands {
                let id = command["id"]
                    .as_str()
                    .ok_or(Error::Invalid("command id missing"))?;
                resource_id(id)?;
                if command["sessionId"]
                    .as_str()
                    .is_some_and(|id| id != session_id)
                {
                    return Err(Error::Invalid("command session does not match target"));
                }
                unique.insert(id.to_owned(), command);
            }
            tx.execute_raw(sql(
                "INSERT INTO cp_commands(machine_id,command_id,record) SELECT $1,record->>'id',record FROM jsonb_array_elements($2::jsonb) record ON CONFLICT(machine_id,command_id) DO UPDATE SET record=excluded.record WHERE cp_commands.record IS DISTINCT FROM excluded.record",
                vec![machine.into(),Value::Array(unique.into_values().collect()).into()],
            )).await?;
        }
        if let Some(snapshot) = snapshot.filter(|_| bound >= current_snapshot_seq) {
            tx.execute_raw(sql(
                "UPDATE cp_sessions SET snapshot=$1,snapshot_seq=$2,event_seq=$3,observed_at=$4 WHERE machine_id=$5 AND session_id=$6 AND (snapshot IS DISTINCT FROM $1 OR event_seq<>$3)",
                vec![snapshot.into(),bound.into(),watermark.into(),now_ms().into(),machine.into(),session_id.into()],
            )).await?;
        } else {
            tx.execute_raw(sql(
                "UPDATE cp_sessions SET event_seq=$1,observed_at=$2 WHERE machine_id=$3 AND session_id=$4 AND event_seq<>$1",
                vec![watermark.into(),now_ms().into(),machine.into(),session_id.into()],
            )).await?;
        }
        tx.commit().await?;
        Ok(watermark.to_string())
    }
}
