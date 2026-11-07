//! Explicit, bounded cleanup of snapshot receipts written before compaction.
use crate::entities::{cp_commands as commands, cp_events as events};
use crate::{ControlStore, Error, Result, one_query};
use sea_orm::{
    ConnectionTrait, TransactionTrait,
    sea_query::{
        Alias, Asterisk, Cond, Expr, ExprTrait, Func, Order, Query, extension::postgres::PgExpr,
    },
};
use serde::Serialize;
use serde_json::Value;

use super::{command_storage, event_storage};

/// Legacy snapshot receipts eligible for, or changed by, explicit cleanup.
#[derive(Default, Debug, Clone, Copy, Serialize)]
pub struct LegacyHistoryCounts {
    pub events: u64,
    pub commands: u64,
}

/// Keyset position for one legacy-history cleanup pass.
///
/// Reuse this cursor across batches to avoid rescanning the processed prefix.
/// Start a new default cursor after restarting an interrupted cleanup process.
#[derive(Default, Debug, Clone)]
pub struct LegacyHistoryCursor {
    events: Option<(i64, String, i64)>,
    commands: Option<(i64, String)>,
    events_done: bool,
}

fn snapshot_receipt(record: Expr) -> Cond {
    let id = record
        .clone()
        .get_json_field(Expr::Constant("result".into()))
        .get_json_field(Expr::Constant("session".into()))
        .get_json_field(Expr::Constant("id".into()));
    Cond::all()
        .add(
            record
                .cast_json_field(Expr::Constant("method".into()))
                .is_in(command_storage::SNAPSHOT_METHODS),
        )
        .add(Func::cust(Alias::new("jsonb_typeof")).arg(id).eq("string"))
}

fn legacy_event() -> Cond {
    // All discriminator keys and supported method names are ASCII. Replacing
    // NUL with U+FFFD cannot change these matches or the snapshot ID's JSON type,
    // so the JSONB projection also identifies eligible exact-text originals.
    Cond::all()
        .add(
            Expr::col(events::Column::Record)
                .cast_json_field(Expr::Constant("kind".into()))
                .eq("command"),
        )
        .add(snapshot_receipt(
            Expr::col(events::Column::Record).get_json_field(Expr::Constant("payload".into())),
        ))
}

impl ControlStore {
    /// Count eligible legacy receipts without changing stored history.
    ///
    /// Both counts share one database snapshot. This explicit diagnostic scans
    /// the receipt predicates; ordinary event payloads are not materialized here.
    ///
    /// # Errors
    /// Returns database errors.
    pub async fn legacy_history_counts(&self) -> Result<LegacyHistoryCounts> {
        let event_count = Query::select()
            .expr(Expr::col(Asterisk).count())
            .from(events::Entity)
            .cond_where(legacy_event())
            .to_owned();
        let command_count = Query::select()
            .expr(Expr::col(Asterisk).count())
            .from(commands::Entity)
            .cond_where(snapshot_receipt(Expr::col(commands::Column::Record)))
            .to_owned();
        let row = one_query(
            &self.db,
            Query::select()
                .expr_as(event_count, Alias::new("events"))
                .expr_as(command_count, Alias::new("commands")),
        )
        .await?;
        Ok(LegacyHistoryCounts {
            events: u64::try_from(row.try_get::<i64>("", "events")?)
                .expect("a row count is nonnegative"),
            commands: u64::try_from(row.try_get::<i64>("", "commands")?)
                .expect("a row count is nonnegative"),
        })
    }

    /// Compact at most `limit` legacy event and command rows in one transaction.
    ///
    /// Row locks serialize this rewrite with other cleanup or command updates.
    /// Event identities and sequence numbers remain unchanged, and the same
    /// normalization used by ingestion keeps old daemon replays equivalent.
    /// The cursor advances only after commit and follows the existing primary
    /// keys, so later batches skip the already scanned prefix. A new pass may
    /// safely restart from a default cursor.
    ///
    /// # Errors
    /// Rejects limits outside 1..=1000; database or JSON errors roll back the batch.
    pub async fn compact_legacy_history_batch(
        &self,
        limit: u32,
        cursor: &mut LegacyHistoryCursor,
    ) -> Result<LegacyHistoryCounts> {
        if !(1..=1000).contains(&limit) {
            return Err(Error::Invalid(
                "history cleanup batch must contain 1 to 1000 rows",
            ));
        }
        let mut next_cursor = cursor.clone();
        let tx = self.db.begin().await?;
        let mut counts = LegacyHistoryCounts::default();
        if !next_cursor.events_done {
            let mut query = Query::select();
            query
                .columns([
                    events::Column::RegistrationId,
                    events::Column::SessionId,
                    events::Column::Seq,
                    events::Column::Record,
                    events::Column::RecordOriginal,
                ])
                .from(events::Entity)
                .cond_where(legacy_event())
                .order_by(events::Column::RegistrationId, Order::Asc)
                .order_by(events::Column::SessionId, Order::Asc)
                .order_by(events::Column::Seq, Order::Asc)
                .limit(u64::from(limit))
                .lock_exclusive();
            if let Some((registration, session, seq)) = &next_cursor.events {
                query.and_where(
                    Expr::tuple([
                        Expr::col(events::Column::RegistrationId),
                        Expr::col(events::Column::SessionId),
                        Expr::col(events::Column::Seq),
                    ])
                    .gt(Expr::tuple([
                        Expr::val(*registration),
                        Expr::val(session.as_str()),
                        Expr::val(*seq),
                    ])),
                );
            }
            let rows = tx.query_all(&query).await?;
            next_cursor.events_done = rows.len() < limit as usize;
            for row in rows {
                let registration = row.try_get::<i64>("", "registration_id")?;
                let session = row.try_get::<String>("", "session_id")?;
                let seq = row.try_get::<i64>("", "seq")?;
                let mut event: Value = match row.try_get::<Option<String>>("", "record_original")? {
                    Some(original) => serde_json::from_str(&original)?,
                    None => row.try_get("", "record")?,
                };
                command_storage::compact_event(&mut event);
                let encoded = event_storage::encode(event);
                let original = encoded["original"].as_str().map(str::to_owned);
                counts.events += tx
                    .execute(
                        Query::update()
                            .table(events::Entity)
                            .value(events::Column::Record, encoded["record"].clone())
                            .value(events::Column::RecordOriginal, original)
                            .and_where(Expr::col(events::Column::RegistrationId).eq(registration))
                            .and_where(Expr::col(events::Column::SessionId).eq(session.as_str()))
                            .and_where(Expr::col(events::Column::Seq).eq(seq)),
                    )
                    .await?
                    .rows_affected();
                next_cursor.events = Some((registration, session, seq));
            }
        }
        let remaining = u64::from(limit) - counts.events;
        if remaining > 0 {
            let mut query = Query::select();
            query
                .columns([
                    commands::Column::RegistrationId,
                    commands::Column::CommandId,
                    commands::Column::Record,
                ])
                .from(commands::Entity)
                .cond_where(snapshot_receipt(Expr::col(commands::Column::Record)))
                .order_by(commands::Column::RegistrationId, Order::Asc)
                .order_by(commands::Column::CommandId, Order::Asc)
                .limit(remaining)
                .lock_exclusive();
            if let Some((registration, command)) = &next_cursor.commands {
                query.and_where(
                    Expr::tuple([
                        Expr::col(commands::Column::RegistrationId),
                        Expr::col(commands::Column::CommandId),
                    ])
                    .gt(Expr::tuple([
                        Expr::val(*registration),
                        Expr::val(command.as_str()),
                    ])),
                );
            }
            let rows = tx.query_all(&query).await?;
            for row in rows {
                let registration = row.try_get::<i64>("", "registration_id")?;
                let id = row.try_get::<String>("", "command_id")?;
                let mut command: Value = row.try_get("", "record")?;
                command_storage::compact(&mut command);
                counts.commands += tx
                    .execute(
                        Query::update()
                            .table(commands::Entity)
                            .value(commands::Column::Record, command)
                            .and_where(Expr::col(commands::Column::RegistrationId).eq(registration))
                            .and_where(Expr::col(commands::Column::CommandId).eq(id.as_str())),
                    )
                    .await?
                    .rows_affected();
                next_cursor.commands = Some((registration, id));
            }
        }
        tx.commit().await?;
        *cursor = next_cursor;
        Ok(counts)
    }
}
