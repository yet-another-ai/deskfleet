use std::collections::BTreeMap;

use crate::entities::{cp_commands as commands, cp_events as events, cp_sessions as sessions};
use crate::{ControlStore, Error, Result, now_ms, one_query, resource_id};
use sea_orm::{
    ConnectionTrait, EntityTrait, Set, TransactionTrait,
    sea_query::{
        Alias, BinOper, Cond, Expr, ExprTrait, Func, IntoIden, JoinType, OnConflict, Query,
        TableRef, extension::postgres::PgExpr,
    },
};
use serde_json::{Value, json};

use super::{command_storage, event_storage, lifecycle};

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
        lifecycle::lock_registration(&tx, machine).await?;
        lifecycle::require_inventory(&tx, machine, session_id).await?;
        if let Some(snapshot) = &snapshot {
            sessions::Entity::insert(sessions::ActiveModel {
                registration_id: Set(machine),
                session_id: Set(session_id.to_owned()),
                snapshot: Set(snapshot.clone()),
                snapshot_seq: Set(bound),
                observed_at: Set(now_ms()),
                ..Default::default()
            })
            .on_conflict(
                OnConflict::columns([
                    sessions::Column::RegistrationId,
                    sessions::Column::SessionId,
                ])
                .do_nothing()
                .to_owned(),
            )
            .exec_without_returning(&tx)
            .await?;
        }
        let row = one_query(
            &tx,
            Query::select()
                .columns([sessions::Column::EventSeq, sessions::Column::SnapshotSeq])
                .from(sessions::Entity)
                .and_where(Expr::col(sessions::Column::RegistrationId).eq(machine))
                .and_where(Expr::col(sessions::Column::SessionId).eq(session_id))
                .and_where(Expr::col(sessions::Column::DeletedAt).is_null())
                .lock_exclusive(),
        )
        .await?;
        let mut watermark = row.try_get::<i64>("", "event_seq")?;
        let current_snapshot_seq = row.try_get::<i64>("", "snapshot_seq")?;
        if let Some(snapshot) = &snapshot
            && bound >= current_snapshot_seq
            && let Some(generation) = snapshot["session"]["admissionGeneration"].as_str()
        {
            self.bind_session_admission(&tx, machine, session_id, generation)
                .await?;
        }
        if snapshot.is_none() && current_snapshot_seq < bound {
            return Err(Error::Conflict("history snapshot is missing"));
        }
        let mut previous = BTreeMap::new();
        if !events.is_empty() {
            // Look up by sequence so unencoded event strings never enter JSONB.
            for row in tx
                .query_all(
                    Query::select()
                        .column((events::Entity, events::Column::Seq))
                        .expr_as(
                            Func::coalesce([
                                Expr::col((events::Entity, events::Column::RecordOriginal)),
                                Expr::col((events::Entity, events::Column::Record)).cast_as("text"),
                            ]),
                            Alias::new("record"),
                        )
                        .from(events::Entity)
                        .join(
                            JoinType::InnerJoin,
                            TableRef::FunctionCall(
                                Func::cust("jsonb_array_elements_text")
                                    .arg(Expr::val(json!(event_sequences)).cast_as("jsonb")),
                                "incoming".into_iden(),
                            ),
                            Expr::col((events::Entity, events::Column::Seq))
                                .eq(Expr::col(Alias::new("incoming")).cast_as("bigint")),
                        )
                        .and_where(
                            Expr::col((events::Entity, events::Column::RegistrationId)).eq(machine),
                        )
                        .and_where(
                            Expr::col((events::Entity, events::Column::SessionId)).eq(session_id),
                        ),
                )
                .await?
            {
                let mut event =
                    serde_json::from_str::<Value>(&row.try_get::<String>("", "record")?)?;
                command_storage::compact_event(&mut event);
                previous.insert(row.try_get::<i64>("", "seq")?, event);
            }
        }
        let mut insertions = Vec::new();
        for (seq, mut event) in event_sequences.into_iter().zip(events) {
            command_storage::compact_event(&mut event);
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
        let terminal_seq = crate::search::terminal_sequence(&insertions);
        if !insertions.is_empty() {
            let stored: Vec<Value> = insertions.into_iter().map(event_storage::encode).collect();
            let event = Expr::col(Alias::new("event"));
            let records = Query::select()
                .expr(Expr::val(machine))
                .expr(Expr::val(session_id))
                .expr(
                    event
                        .clone()
                        .get_json_field(Expr::Constant("record".into()))
                        .cast_json_field(Expr::Constant("seq".into()))
                        .cast_as("bigint"),
                )
                .expr(
                    event
                        .clone()
                        .get_json_field(Expr::Constant("record".into())),
                )
                .expr(event.cast_json_field(Expr::Constant("original".into())))
                .from_function(
                    Func::cust("jsonb_array_elements")
                        .arg(Expr::val(Value::Array(stored)).cast_as("jsonb")),
                    Alias::new("event"),
                )
                .to_owned();
            tx.execute(
                Query::insert()
                    .into_table(events::Entity)
                    .columns([
                        events::Column::RegistrationId,
                        events::Column::SessionId,
                        events::Column::Seq,
                        events::Column::Record,
                        events::Column::RecordOriginal,
                    ])
                    .select_from(records)
                    .expect("event projection matches insert columns"),
            )
            .await?;
        }
        if bound >= current_snapshot_seq && !commands.is_empty() {
            let mut unique = BTreeMap::new();
            for mut command in commands {
                command_storage::compact(&mut command);
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
            let record = Expr::col(Alias::new("record"));
            let records = Query::select()
                .expr(Expr::val(machine))
                .expr(record.clone().cast_json_field(Expr::Constant("id".into())))
                .expr(record)
                .from_function(
                    Func::cust("jsonb_array_elements").arg(
                        Expr::val(Value::Array(unique.into_values().collect())).cast_as("jsonb"),
                    ),
                    Alias::new("record"),
                )
                .to_owned();
            tx.execute(
                Query::insert()
                    .into_table(commands::Entity)
                    .columns([
                        commands::Column::RegistrationId,
                        commands::Column::CommandId,
                        commands::Column::Record,
                    ])
                    .select_from(records)
                    .expect("command projection matches insert columns")
                    .on_conflict(
                        OnConflict::columns([
                            commands::Column::RegistrationId,
                            commands::Column::CommandId,
                        ])
                        .update_column(commands::Column::Record)
                        .action_and_where(
                            Expr::col((commands::Entity, commands::Column::Record)).binary(
                                BinOper::Custom("IS DISTINCT FROM"),
                                Expr::col((Alias::new("excluded"), commands::Column::Record)),
                            ),
                        )
                        .to_owned(),
                    ),
            )
            .await?;
        }
        crate::search::project_history(
            &tx,
            machine,
            session_id,
            snapshot.as_ref().filter(|_| bound >= current_snapshot_seq),
            watermark,
            terminal_seq,
        )
        .await?;
        if let Some(snapshot) = snapshot.filter(|_| bound >= current_snapshot_seq) {
            tx.execute(
                Query::update()
                    .table(sessions::Entity)
                    .value(sessions::Column::Snapshot, snapshot.clone())
                    .value(sessions::Column::SnapshotSeq, bound)
                    .value(sessions::Column::EventSeq, watermark)
                    .value(sessions::Column::ObservedAt, now_ms())
                    .and_where(Expr::col(sessions::Column::RegistrationId).eq(machine))
                    .and_where(Expr::col(sessions::Column::SessionId).eq(session_id))
                    .cond_where(
                        Cond::any()
                            .add(
                                Expr::col(sessions::Column::Snapshot).binary(
                                    BinOper::Custom("IS DISTINCT FROM"),
                                    Expr::val(snapshot),
                                ),
                            )
                            .add(Expr::col(sessions::Column::EventSeq).ne(watermark)),
                    ),
            )
            .await?;
        } else {
            tx.execute(
                Query::update()
                    .table(sessions::Entity)
                    .value(sessions::Column::EventSeq, watermark)
                    .value(sessions::Column::ObservedAt, now_ms())
                    .and_where(Expr::col(sessions::Column::RegistrationId).eq(machine))
                    .and_where(Expr::col(sessions::Column::SessionId).eq(session_id))
                    .and_where(Expr::col(sessions::Column::EventSeq).ne(watermark)),
            )
            .await?;
        }
        tx.commit().await?;
        Ok(watermark.to_string())
    }
}
