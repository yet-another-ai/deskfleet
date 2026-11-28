use crate::entities::cp_cloud_sessions::{Column, Entity};
use crate::{ControlStore, Error, Result, now_ms, resource_id};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseTransaction, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, TransactionTrait,
    sea_query::{Cond, Expr, Func, LockBehavior, LockType, OnConflict, Query},
};
use serde::Serialize;

#[derive(Debug, Serialize, sea_orm::FromQueryResult)]
#[serde(rename_all = "camelCase")]
pub struct CloudSessionSummary {
    pub session_id: String,
    pub title: Option<String>,
    pub last_active_at: i64,
    pub archived: bool,
}

/// A bounded catch-up read against one durable eve event stream.
#[derive(Debug)]
pub struct CloudMeterCursor {
    pub session_id: String,
    pub team_id: String,
    pub next_line: i64,
    pub last_active_at: i64,
    claim_until: i64,
}

impl ControlStore {
    pub async fn bind_cloud_session(&self, team_id: &str, session_id: &str) -> Result<()> {
        let inserted = self
            .db
            .execute(
                Query::insert()
                    .into_table(Entity)
                    .columns([Column::SessionId, Column::TeamId, Column::LastActiveAt])
                    .values_panic([
                        session_id.into(),
                        resource_id(team_id)?.into(),
                        now_ms().into(),
                    ])
                    .on_conflict(
                        OnConflict::column(Column::SessionId)
                            .do_nothing()
                            .to_owned(),
                    ),
            )
            .await?;
        if inserted.rows_affected() == 0 {
            self.require_active_cloud_session(team_id, session_id)
                .await?;
        }
        Ok(())
    }

    pub async fn cloud_sessions(&self, team_id: &str) -> Result<Vec<CloudSessionSummary>> {
        Ok(Entity::find()
            .select_only()
            .columns([
                Column::SessionId,
                Column::Title,
                Column::LastActiveAt,
                Column::Archived,
            ])
            .filter(Column::TeamId.eq(resource_id(team_id)?))
            .filter(Column::DeletedAt.is_null())
            .order_by_desc(Column::LastActiveAt)
            .order_by_asc(Column::SessionId)
            .into_model()
            .all(&self.db)
            .await?)
    }

    /// Give a conversation its first accepted message as a short, single-line label.
    pub async fn name_cloud_session(
        &self,
        team_id: &str,
        session_id: &str,
        message: &str,
    ) -> Result<()> {
        let title: String = message
            .trim()
            .lines()
            .next()
            .unwrap_or_default()
            .trim_end()
            .chars()
            .filter(|character| !character.is_control())
            .take(80)
            .collect();
        if title.is_empty() {
            return Ok(());
        }
        Entity::update_many()
            .col_expr(Column::Title, Expr::val(title))
            .filter(Column::TeamId.eq(resource_id(team_id)?))
            .filter(Column::SessionId.eq(session_id))
            .filter(Column::DeletedAt.is_null())
            .filter(Column::Title.is_null())
            .exec(&self.db)
            .await?;
        Ok(())
    }

    /// Serialize lifecycle changes with upstream deliveries across API replicas.
    pub async fn lock_cloud_session(
        &self,
        team_id: &str,
        session_id: &str,
    ) -> Result<CloudSessionGuard> {
        let tx = self.db.begin().await?;
        let row = Entity::find_by_id(session_id)
            .filter(Column::TeamId.eq(resource_id(team_id)?))
            .filter(Column::DeletedAt.is_null())
            .lock_exclusive()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        Ok(CloudSessionGuard {
            tx,
            session_id: row.session_id,
            archived: row.archived,
        })
    }

    pub async fn require_active_cloud_session(
        &self,
        team_id: &str,
        session_id: &str,
    ) -> Result<()> {
        let row = Entity::find_by_id(session_id)
            .filter(Column::TeamId.eq(resource_id(team_id)?))
            .filter(Column::DeletedAt.is_null())
            .one(&self.db)
            .await?
            .ok_or(Error::NotFound)?;
        require_active(row.archived)
    }

    pub async fn owns_cloud_session(&self, team_id: &str, session_id: &str) -> Result<bool> {
        Ok(Entity::find_by_id(session_id)
            .filter(Column::TeamId.eq(resource_id(team_id)?))
            .filter(Column::DeletedAt.is_null())
            .one(&self.db)
            .await?
            .is_some())
    }

    pub async fn wake_cloud_meter(&self, team_id: &str, session_id: &str) -> Result<()> {
        let now = now_ms();
        Entity::update_many()
            .col_expr(Column::NextCheckAt, Expr::val(now))
            .col_expr(Column::LastActiveAt, Expr::val(now))
            .filter(Column::SessionId.eq(session_id))
            .filter(Column::TeamId.eq(resource_id(team_id)?))
            .exec(&self.db)
            .await?;
        Ok(())
    }

    pub async fn claim_cloud_meter(&self, claim_ms: i64) -> Result<Option<CloudMeterCursor>> {
        let now = now_ms();
        let claim_until = now.saturating_add(claim_ms);
        let tx = self.db.begin().await?;
        let row = Entity::find()
            .filter(
                Cond::any().add(Column::MeterClaimUntil.lte(now)).add(
                    Cond::all()
                        .add(Column::MeterClaimUntil.is_null())
                        .add(Column::NextCheckAt.lte(now)),
                ),
            )
            .order_by_asc(Func::coalesce([
                Expr::col(Column::NextCheckAt),
                Expr::col(Column::MeterClaimUntil),
            ]))
            .order_by_asc(Column::SessionId)
            .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
            .one(&tx)
            .await?;
        let cursor = if let Some(row) = row {
            Entity::update_many()
                .col_expr(Column::MeterClaimUntil, Expr::val(claim_until))
                .col_expr(Column::NextCheckAt, Expr::val(None::<i64>))
                .filter(Column::SessionId.eq(&row.session_id))
                .exec(&tx)
                .await?;
            Some(CloudMeterCursor {
                session_id: row.session_id,
                team_id: row.team_id.to_string(),
                next_line: row.next_line,
                last_active_at: row.last_active_at,
                claim_until,
            })
        } else {
            None
        };
        tx.commit().await?;
        Ok(cursor)
    }

    /// Usage receipts have already been committed. A lost claim replays them safely.
    pub async fn finish_cloud_meter(
        &self,
        cursor: &CloudMeterCursor,
        next_line: i64,
        next_check_at: Option<i64>,
    ) -> Result<()> {
        let mut update = Entity::update_many();
        if next_line > cursor.next_line {
            update = update.col_expr(Column::LastActiveAt, Expr::val(now_ms()));
        }
        // A delivery accepted during the read queued its own wake. Commit this
        // cursor under its original lease and preserve that wake for the next reader.
        update
            .col_expr(Column::NextLine, Expr::val(next_line))
            .col_expr(
                Column::NextCheckAt,
                Func::coalesce([Expr::col(Column::NextCheckAt), Expr::val(next_check_at)]).into(),
            )
            .col_expr(Column::MeterClaimUntil, Expr::val(None::<i64>))
            .filter(Column::SessionId.eq(&cursor.session_id))
            .filter(Column::NextLine.eq(cursor.next_line))
            .filter(Column::MeterClaimUntil.eq(cursor.claim_until))
            .exec(&self.db)
            .await?;
        Ok(())
    }
}

/// Holds the Session row while its Eve control or delivery is in flight. Dropping
/// the guard on an upstream error rolls back the local lifecycle transition.
pub struct CloudSessionGuard {
    tx: DatabaseTransaction,
    session_id: String,
    pub archived: bool,
}

fn require_active(archived: bool) -> Result<()> {
    if archived {
        return Err(Error::Conflict("Super Agent session is archived"));
    }
    Ok(())
}

impl CloudSessionGuard {
    pub fn require_active(&self) -> Result<()> {
        require_active(self.archived)
    }

    pub async fn set_archived(self, archived: bool) -> Result<()> {
        Entity::update_many()
            .col_expr(Column::Archived, Expr::val(archived))
            .filter(Column::SessionId.eq(&self.session_id))
            .exec(&self.tx)
            .await?;
        self.finish().await
    }

    pub async fn delete(self) -> Result<()> {
        Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::val(now_ms()))
            .col_expr(Column::Title, Expr::val(None::<String>))
            .filter(Column::SessionId.eq(&self.session_id))
            .exec(&self.tx)
            .await?;
        self.finish().await
    }

    pub async fn finish(self) -> Result<()> {
        self.tx.commit().await?;
        Ok(())
    }
}
