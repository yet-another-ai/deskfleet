use crate::{ControlStore, Result, now_ms, one_query};
use sea_orm::sea_query::{Alias, Expr, Func, Query};

const RAW_RETENTION_MS: i64 = 7 * 86_400_000;

impl ControlStore {
    /// Compact at most `limit` TURN notifications older than seven days.
    ///
    /// Durable Team/minute archives retain exact millisecond offsets for
    /// historical billing. Only allocation-level diagnostics expire.
    ///
    /// # Errors
    /// Returns database errors without removing unarchived usage.
    pub async fn compact_turn_usage(&self, limit: i64) -> Result<u64> {
        // PostgreSQL's data-modifying CTE moves each batch atomically, including
        // numeric counter merging and SKIP LOCKED ownership. Keep this operation
        // in the migration-owned function so readers see either raw or archived
        // boundary counters, never an intermediate state.
        let removed: i64 = one_query(
            &self.db,
            Query::select().expr_as(
                Func::cust(Alias::new("cp_compact_turn_usage")).args([
                    Expr::val(now_ms() - RAW_RETENTION_MS),
                    Expr::val(limit.clamp(1, 10_000)),
                ]),
                Alias::new("removed"),
            ),
        )
        .await?
        .try_get("", "removed")?;
        Ok(u64::try_from(removed).expect("a deleted row count is nonnegative"))
    }
}
