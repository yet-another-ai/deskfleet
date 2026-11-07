use crate::entities::{
    cp_catalogs as catalogs, cp_commands as commands, cp_events as events,
    cp_machine_registrations as registrations, cp_sessions as sessions,
};
use crate::{ControlStore, Error, Result, json_query, now_ms, one_query, resource_id, timestamp};
use sea_orm::{
    ConnectionTrait, EntityTrait, Set, TransactionTrait,
    sea_query::{
        Alias, BinOper, Expr, ExprTrait, Func, JoinType, OnConflict, Order, Query, SelectStatement,
        extension::postgres::PgExpr,
    },
};

mod cleanup;
mod command_storage;
mod event_storage;
mod lifecycle;
mod purge;
mod sync;
pub use cleanup::{LegacyHistoryCounts, LegacyHistoryCursor};
pub use purge::PurgedHistoryCounts;
use serde_json::{Value, json};

impl ControlStore {
    pub async fn save_catalog(
        &self,
        machine_id: &str,
        revision: &str,
        snapshot: Value,
        providers: Value,
    ) -> Result<()> {
        let registration = resource_id(machine_id)?;
        let revision = resource_id(revision)?;
        let tx = self.db.begin().await?;
        lifecycle::lock_registration(&tx, registration).await?;
        if let Some(previous) = tx
            .query_one(
                Query::select()
                    .column(catalogs::Column::InventoryRevision)
                    .from(catalogs::Entity)
                    .and_where(Expr::col(catalogs::Column::RegistrationId).eq(registration)),
            )
            .await?
            && previous.try_get::<i64>("", "inventory_revision")? >= revision
        {
            tx.commit().await?;
            return Ok(());
        }
        lifecycle::mark_removed(&tx, registration, &snapshot).await?;
        catalogs::Entity::insert(catalogs::ActiveModel {
            registration_id: Set(registration),
            snapshot: Set(snapshot),
            providers: Set(providers),
            observed_at: Set(now_ms()),
            inventory_revision: Set(revision),
        })
        .on_conflict(
            OnConflict::column(catalogs::Column::RegistrationId)
                .update_columns([
                    catalogs::Column::Snapshot,
                    catalogs::Column::Providers,
                    catalogs::Column::ObservedAt,
                    catalogs::Column::InventoryRevision,
                ])
                .to_owned(),
        )
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn catalog(&self, machine_id: &str) -> Result<Value> {
        let row = one_query(
            &self.db,
            Query::select()
                .columns([
                    catalogs::Column::Snapshot,
                    catalogs::Column::Providers,
                    catalogs::Column::ObservedAt,
                ])
                .column((registrations::Entity, registrations::Column::MachineId))
                .from(catalogs::Entity)
                .join(
                    JoinType::InnerJoin,
                    registrations::Entity,
                    Expr::col((registrations::Entity, registrations::Column::Id)).eq(Expr::col((
                        catalogs::Entity,
                        catalogs::Column::RegistrationId,
                    ))),
                )
                .and_where(
                    Expr::col((catalogs::Entity, catalogs::Column::RegistrationId))
                        .eq(resource_id(machine_id)?),
                ),
        )
        .await?;
        Ok(
            json!({"machineId":row.try_get::<i64>("", "machine_id")?.to_string(),"snapshot":row.try_get::<Value>("","snapshot")?,"providers":row.try_get::<Value>("","providers")?,"lastObservedAt":timestamp(row.try_get("","observed_at")?)}),
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
        // Filter by the daemon inventory before pagination: retained history cannot
        // restore a Session removed from its catalog.
        let mut query = session_summaries(resource_id(machine_id)?);
        query
            .and_where(
                Expr::col(sessions::Column::SessionId)
                    .cast_as("bigint")
                    .gt(after),
            )
            .order_by_expr(
                Expr::col(sessions::Column::SessionId).cast_as("bigint"),
                Order::Asc,
            )
            .limit(u64::from(limit + 1));
        if archive != "all" {
            query.and_where(
                Expr::col(sessions::Column::Summary)
                    .binary(
                        BinOper::Custom("#>>"),
                        Expr::Constant("{session,archiveState}".into()),
                    )
                    .eq(archive),
            );
        }
        let rows = json_query(&self.db, &query).await?;
        Ok(page(rows, limit, "sessions", "/session/id"))
    }
    pub async fn session_summary(&self, machine_id: &str, session_id: &str) -> Result<Value> {
        let rows = json_query(
            &self.db,
            session_summaries(resource_id(machine_id)?)
                .and_where(Expr::col(sessions::Column::SessionId).eq(session_id)),
        )
        .await?;
        Ok(json!({"sessions": rows}))
    }
    pub async fn session_snapshot(&self, machine_id: &str, session_id: &str) -> Result<Value> {
        let row = one_query(
            &self.db,
            Query::select()
                .columns([
                    sessions::Column::Snapshot,
                    sessions::Column::EventSeq,
                    sessions::Column::ObservedAt,
                ])
                .from(sessions::Entity)
                .and_where(Expr::col(sessions::Column::RegistrationId).eq(resource_id(machine_id)?))
                .and_where(Expr::col(sessions::Column::SessionId).eq(session_id))
                .and_where(Expr::col(sessions::Column::DeletedAt).is_null()),
        )
        .await?;
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
        // Keep the page and watermark on one MVCC snapshot. JSON (not JSONB)
        // preserves escaped NUL in originals. SeaQuery has no ordered-aggregate
        // argument API, so only that expression's syntax is supplied explicitly.
        let machine = resource_id(machine_id)?;
        let event_page = Query::select()
            .columns([
                events::Column::Seq,
                events::Column::Record,
                events::Column::RecordOriginal,
            ])
            .from(events::Entity)
            .and_where(Expr::col(events::Column::RegistrationId).eq(machine))
            .and_where(Expr::col(events::Column::SessionId).eq(session_id))
            .and_where(Expr::col(events::Column::Seq).gt(after))
            .order_by(events::Column::Seq, Order::Asc)
            .limit(u64::from(limit))
            .to_owned();
        let aggregate = Query::select()
            .expr(Expr::cust_with_exprs(
                "json_agg($1 ORDER BY $2)",
                [
                    Func::coalesce([
                        Expr::col((Alias::new("page"), events::Column::RecordOriginal)),
                        Expr::col((Alias::new("page"), events::Column::Record)).cast_as("text"),
                    ])
                    .cast_as("json"),
                    Expr::col((Alias::new("page"), events::Column::Seq)),
                ],
            ))
            .from_subquery(event_page, Alias::new("page"))
            .to_owned();
        let row = one_query(
            &self.db,
            Query::select()
                .column(sessions::Column::EventSeq)
                .expr_as(
                    Func::coalesce([Expr::from(aggregate), Expr::val("[]").cast_as("json")]),
                    Alias::new("events"),
                )
                .from(sessions::Entity)
                .and_where(Expr::col(sessions::Column::RegistrationId).eq(machine))
                .and_where(Expr::col(sessions::Column::SessionId).eq(session_id))
                .and_where(Expr::col(sessions::Column::DeletedAt).is_null()),
        )
        .await?;
        let watermark: i64 = row.try_get("", "event_seq")?;
        let mut events: Value = row.try_get("", "events")?;
        if let Some(events) = events.as_array_mut() {
            events.iter_mut().for_each(command_storage::compact_event);
        }
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
        let mut rows = json_query(
            &self.db,
            Query::select()
                .column(commands::Column::Record)
                .from(commands::Entity)
                .and_where(Expr::col(commands::Column::RegistrationId).eq(resource_id(machine_id)?))
                .and_where(Expr::exists(lifecycle::active_session(
                    resource_id(machine_id)?,
                    Expr::val(session_id),
                )))
                .and_where(
                    Expr::col(commands::Column::Record)
                        .cast_json_field(Expr::Constant("sessionId".into()))
                        .eq(session_id),
                )
                .and_where(
                    Expr::col(commands::Column::CommandId)
                        .cast_as("bigint")
                        .gt(after),
                )
                .order_by_expr(
                    Expr::col(commands::Column::CommandId).cast_as("bigint"),
                    Order::Asc,
                )
                .limit(u64::from(limit + 1)),
        )
        .await?;
        rows.iter_mut().for_each(command_storage::compact);
        Ok(page(rows, limit, "commands", "/id"))
    }
    pub async fn command_by_operation(&self, machine_id: &str, operation: &str) -> Result<Value> {
        let row = one_query(
            &self.db,
            Query::select()
                .column(commands::Column::Record)
                .from(commands::Entity)
                .and_where(Expr::col(commands::Column::RegistrationId).eq(resource_id(machine_id)?))
                .and_where(Expr::exists(lifecycle::active_session(
                    resource_id(machine_id)?,
                    Expr::col((commands::Entity, commands::Column::Record))
                        .cast_json_field(Expr::Constant("sessionId".into())),
                )))
                .and_where(
                    Expr::col(commands::Column::Record)
                        .cast_json_field(Expr::Constant("operationId".into()))
                        .eq(operation),
                )
                .and_where(
                    Expr::col(commands::Column::Record)
                        .cast_json_field(Expr::Constant("isCanonical".into()))
                        .eq("true"),
                )
                .limit(1),
        )
        .await?;
        let mut command: Value = row.try_get("", "record")?;
        command_storage::compact(&mut command);
        Ok(command)
    }
}

fn session_summaries(machine: i64) -> SelectStatement {
    let inventory = Query::select()
        .expr(
            Expr::col(catalogs::Column::Snapshot)
                .get_json_field(Expr::Constant("sessionIds".into())),
        )
        .from(catalogs::Entity)
        .and_where(Expr::col(catalogs::Column::RegistrationId).eq(machine))
        .to_owned();
    Query::select()
        .expr_as(Expr::col(sessions::Column::Summary), Alias::new("record"))
        .from(sessions::Entity)
        .and_where(Expr::col(sessions::Column::RegistrationId).eq(machine))
        .and_where(Expr::col(sessions::Column::DeletedAt).is_null())
        // PostgreSQL's JSONB key-existence operator is not exposed by PgBinOper.
        .and_where(
            Expr::from(inventory)
                .binary(BinOper::Custom("?"), Expr::col(sessions::Column::SessionId)),
        )
        .to_owned()
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
