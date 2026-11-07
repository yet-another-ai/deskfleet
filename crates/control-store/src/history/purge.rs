//! Explicit, bounded removal of content belonging to soft-deleted Sessions.
use crate::entities::{
    cp_commands as commands, cp_events as events, cp_search_documents as documents,
    cp_search_entries as entries, cp_search_progress as progress, cp_sessions as sessions,
};
use crate::{ControlStore, Error, Result, one_query};
use sea_orm::{
    ConnectionTrait, EntityTrait, Iterable, PrimaryKeyToColumn, TransactionTrait,
    sea_query::{
        Alias, Asterisk, Cond, Expr, ExprTrait, IntoTableRef, Order, Query, SelectStatement,
        extension::postgres::PgExpr,
    },
};
use serde::Serialize;
use serde_json::json;

/// Content selected by a preview, or removed by one committed cleanup batch.
/// A removed Session means its snapshot was cleared; its tombstone remains.
#[derive(Default, Debug, Clone, Copy, Serialize)]
pub struct PurgedHistoryCounts {
    pub sessions: u64,
    pub events: u64,
    pub commands: u64,
    pub search_documents: u64,
    pub search_entries: u64,
    pub search_progress: u64,
}

impl ControlStore {
    /// Preview content from Sessions deleted strictly before the explicit cutoff.
    /// All counts use one statement snapshot and do not change stored data.
    ///
    /// # Errors
    /// Returns database errors when the eligible content cannot be counted.
    pub async fn deleted_history_counts(&self, before: i64) -> Result<PurgedHistoryCounts> {
        let row = one_query(
            &self.db,
            Query::select()
                .expr_as(count(sessions::Entity, pending(before)), "sessions")
                .expr_as(
                    count(
                        events::Entity,
                        Cond::all().add(eligible_child(
                            before,
                            Expr::col((events::Entity, events::Column::RegistrationId)),
                            Expr::col((events::Entity, events::Column::SessionId)),
                        )),
                    ),
                    "events",
                )
                .expr_as(
                    count(
                        commands::Entity,
                        Cond::all().add(eligible_child(
                            before,
                            Expr::col((commands::Entity, commands::Column::RegistrationId)),
                            command_session(),
                        )),
                    ),
                    "commands",
                )
                .expr_as(
                    count(
                        documents::Entity,
                        Cond::all()
                            .add(Expr::col(documents::Column::Kind).eq("chat"))
                            .add(eligible_child(
                                before,
                                Expr::col((documents::Entity, documents::Column::RegistrationId)),
                                Expr::col((documents::Entity, documents::Column::ResourceId)),
                            )),
                    ),
                    "search_documents",
                )
                .expr_as(
                    count(
                        entries::Entity,
                        Cond::all().add(eligible_child(
                            before,
                            Expr::col((entries::Entity, entries::Column::RegistrationId)),
                            Expr::col((entries::Entity, entries::Column::SessionId)),
                        )),
                    ),
                    "search_entries",
                )
                .expr_as(
                    count(
                        progress::Entity,
                        Cond::all().add(eligible_child(
                            before,
                            Expr::col((progress::Entity, progress::Column::RegistrationId)),
                            Expr::col((progress::Entity, progress::Column::SessionId)),
                        )),
                    ),
                    "search_progress",
                ),
        )
        .await?;
        let read = |name| -> Result<u64> {
            Ok(u64::try_from(row.try_get::<i64>("", name)?)
                .expect("a counted row total is nonnegative"))
        };
        Ok(PurgedHistoryCounts {
            sessions: read("sessions")?,
            events: read("events")?,
            commands: read("commands")?,
            search_documents: read("search_documents")?,
            search_entries: read("search_entries")?,
            search_progress: read("search_progress")?,
        })
    }

    /// Remove at most `limit` rows from each content table for one deleted Session.
    /// The cutoff is exclusive and `limit` must be between 1 and 1,000.
    ///
    /// Snapshot content is cleared only after all its child content is gone. The
    /// tombstone and sequence watermarks remain to reject stale daemon uploads;
    /// AI usage, admissions, and all other billing facts remain untouched.
    ///
    /// # Errors
    /// Returns invalid-limit or database errors. A failed batch rolls back fully.
    pub async fn purge_deleted_history_batch(
        &self,
        before: i64,
        limit: u32,
    ) -> Result<PurgedHistoryCounts> {
        if !(1..=1000).contains(&limit) {
            return Err(Error::Invalid(
                "history cleanup batch size must be between 1 and 1000",
            ));
        }
        loop {
            let tx = self.db.begin().await?;
            let candidate = tx
                .query_one(
                    Query::select()
                        .columns([
                            sessions::Column::RegistrationId,
                            sessions::Column::SessionId,
                        ])
                        .from(sessions::Entity)
                        .cond_where(pending(before))
                        .order_by(sessions::Column::DeletedAt, Order::Asc)
                        .order_by(sessions::Column::RegistrationId, Order::Asc)
                        .order_by(sessions::Column::SessionId, Order::Asc)
                        .limit(1),
                )
                .await?;
            let Some(candidate) = candidate else {
                tx.commit().await?;
                return Ok(PurgedHistoryCounts::default());
            };
            let registration: i64 = candidate.try_get("", "registration_id")?;
            let session: String = candidate.try_get("", "session_id")?;
            // Use the same parent-first lock order as catalog replacement and
            // ingestion, then revalidate against a fresh statement snapshot.
            super::lifecycle::lock_registration(&tx, registration).await?;
            let target = session_scope(registration, &session);
            if tx
                .query_one(
                    Query::select()
                        .expr(Expr::val(1))
                        .from(sessions::Entity)
                        .cond_where(pending(before))
                        .cond_where(target.clone())
                        .lock_exclusive(),
                )
                .await?
                .is_none()
            {
                tx.commit().await?;
                // Another cleaner may have completed the chosen Session while
                // we waited. Continue until there is truly no eligible work.
                continue;
            }
            let scopes = ContentScopes::new(registration, &session);
            let mut removed = PurgedHistoryCounts {
                events: delete_batch::<events::Entity>(&tx, scopes.events.clone(), limit).await?,
                commands: delete_batch::<commands::Entity>(&tx, scopes.commands.clone(), limit)
                    .await?,
                search_documents: delete_batch::<documents::Entity>(
                    &tx,
                    scopes.documents.clone(),
                    limit,
                )
                .await?,
                search_entries: delete_batch::<entries::Entity>(&tx, scopes.entries.clone(), limit)
                    .await?,
                search_progress: delete_batch::<progress::Entity>(
                    &tx,
                    scopes.progress.clone(),
                    limit,
                )
                .await?,
                ..Default::default()
            };
            let remaining: bool = one_query(
                &tx,
                Query::select().expr_as(
                    Expr::exists(content(events::Entity, scopes.events))
                        .or(Expr::exists(content(commands::Entity, scopes.commands)))
                        .or(Expr::exists(content(documents::Entity, scopes.documents)))
                        .or(Expr::exists(content(entries::Entity, scopes.entries)))
                        .or(Expr::exists(content(progress::Entity, scopes.progress))),
                    "remaining",
                ),
            )
            .await?
            .try_get("", "remaining")?;
            if !remaining {
                removed.sessions = tx
                    .execute(
                        Query::update()
                            .table(sessions::Entity)
                            .value(sessions::Column::Snapshot, json!({}))
                            .cond_where(target),
                    )
                    .await?
                    .rows_affected();
            }
            tx.commit().await?;
            return Ok(removed);
        }
    }
}

fn pending(before: i64) -> Cond {
    Cond::all()
        .add(Expr::col((sessions::Entity, sessions::Column::DeletedAt)).lt(before))
        .add(Expr::col((sessions::Entity, sessions::Column::Snapshot)).ne(json!({})))
}

fn eligible_child(before: i64, registration: Expr, session: Expr) -> Expr {
    Expr::exists(
        Query::select()
            .expr(Expr::val(1))
            .from(sessions::Entity)
            .cond_where(pending(before))
            .and_where(
                Expr::col((sessions::Entity, sessions::Column::RegistrationId)).eq(registration),
            )
            .and_where(Expr::col((sessions::Entity, sessions::Column::SessionId)).eq(session))
            .to_owned(),
    )
}

fn command_session() -> Expr {
    Expr::col((commands::Entity, commands::Column::Record))
        .cast_json_field(Expr::Constant("sessionId".into()))
}

fn session_scope(registration: i64, session: &str) -> Cond {
    Cond::all()
        .add(Expr::col(sessions::Column::RegistrationId).eq(registration))
        .add(Expr::col(sessions::Column::SessionId).eq(session))
}

struct ContentScopes {
    events: Cond,
    commands: Cond,
    documents: Cond,
    entries: Cond,
    progress: Cond,
}

impl ContentScopes {
    fn new(registration: i64, session: &str) -> Self {
        Self {
            events: Cond::all()
                .add(Expr::col(events::Column::RegistrationId).eq(registration))
                .add(Expr::col(events::Column::SessionId).eq(session)),
            commands: Cond::all()
                .add(Expr::col(commands::Column::RegistrationId).eq(registration))
                .add(command_session().eq(session)),
            documents: Cond::all()
                .add(Expr::col(documents::Column::RegistrationId).eq(registration))
                .add(Expr::col(documents::Column::Kind).eq("chat"))
                .add(Expr::col(documents::Column::ResourceId).eq(session)),
            entries: Cond::all()
                .add(Expr::col(entries::Column::RegistrationId).eq(registration))
                .add(Expr::col(entries::Column::SessionId).eq(session)),
            progress: Cond::all()
                .add(Expr::col(progress::Column::RegistrationId).eq(registration))
                .add(Expr::col(progress::Column::SessionId).eq(session)),
        }
    }
}

fn content(table: impl IntoTableRef, condition: Cond) -> SelectStatement {
    Query::select()
        .expr(Expr::val(1))
        .from(table)
        .cond_where(condition)
        .to_owned()
}

fn count(table: impl IntoTableRef, condition: Cond) -> SelectStatement {
    Query::select()
        .expr(Expr::col(Asterisk).count())
        .from(table)
        .cond_where(condition)
        .to_owned()
}

async fn delete_batch<E: EntityTrait>(
    db: &impl ConnectionTrait,
    condition: Cond,
    limit: u32,
) -> Result<u64> {
    // PostgreSQL's ctid identifies only this statement's selected row versions.
    // The registration lock excludes all history writers for this Session.
    let mut selected = Query::select()
        .column(Alias::new("ctid"))
        .from(E::default())
        .cond_where(condition)
        .limit(u64::from(limit))
        .lock_exclusive()
        .to_owned();
    // Legacy receipt compaction locks events/commands in primary-key order.
    // Match that order so concurrent maintenance cannot acquire rows in reverse.
    for key in E::PrimaryKey::iter() {
        selected.order_by(key.into_column(), Order::Asc);
    }
    Ok(db
        .execute(
            Query::delete()
                .from_table(E::default())
                .and_where(Expr::col(Alias::new("ctid")).in_subquery(selected)),
        )
        .await?
        .rows_affected())
}
