//! Bounded expiration of credentials that have no post-expiry consumers.
use crate::{ControlStore, Result, now_ms, sql};
use sea_orm::ConnectionTrait;

impl ControlStore {
    /// Remove at most `limit` expired rows from each short-lived identity table.
    /// The server's shared maintenance lease coalesces passes across replicas.
    /// Locked ceremonies are skipped so maintenance cannot delay authentication.
    /// Login sessions and peer grants remain available for acknowledged cleanup.
    ///
    /// # Errors
    /// Returns an error when an expiration query fails.
    pub async fn prune_auth_records(&self, limit: i64) -> Result<u64> {
        let limit = limit.clamp(1, 1_000);
        let now = now_ms();
        let mut removed = 0;
        for (table, expiry, cutoff) in [
            ("cp_auth_limits", "period", now - 3_600_000),
            ("cp_login_attempts", "expires_at", now),
            ("cp_login_codes", "expires_at", now),
            ("cp_identity_challenges", "expires_at", now),
            ("cp_invites", "expires_at", now),
        ] {
            // Identifiers are fixed above; ctid is only used within this statement.
            let statement = format!(
                "WITH expired AS (SELECT ctid FROM {table} WHERE {expiry}<$1 ORDER BY {expiry} LIMIT $2 FOR UPDATE SKIP LOCKED) DELETE FROM {table} USING expired WHERE {table}.ctid=expired.ctid"
            );
            removed += self
                .db
                .execute_raw(sql(&statement, vec![cutoff.into(), limit.into()]))
                .await?
                .rows_affected();
        }
        Ok(removed)
    }
}
