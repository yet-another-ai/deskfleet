//! Operator-only maintenance, separate from migrations and the HTTP service.
use crate::{ControlStore, Error, Result, one_query, schema};
use sea_orm::{
    ConnectionTrait,
    sea_query::{Alias, Func, Query},
};

impl ControlStore {
    /// Open an already upgraded database without running migrations.
    ///
    /// Cleanup previews must never perform schema changes. Migration 31 protects
    /// durable AI usage when a deleted Session's snapshot is cleared.
    ///
    /// # Errors
    /// Returns a connection error or rejects a database missing migration 31.
    pub async fn connect_for_cleanup(url: &str) -> Result<Self> {
        let store = Self::open(url).await?;
        let versions = schema::applied_versions(&store.db).await?;
        if !versions.is_some_and(|versions| versions.contains(&31)) {
            store.close().await?;
            return Err(Error::Invalid(
                "storage cleanup requires migration 31; start the upgraded server to apply migrations first",
            ));
        }
        Ok(store)
    }

    /// Allocated database bytes, including indexes and free space but not WAL.
    ///
    /// # Errors
    /// Returns database errors when the database size cannot be inspected.
    pub async fn storage_size_bytes(&self) -> Result<u64> {
        let bytes: i64 = one_query(
            &self.db,
            Query::select().expr_as(
                Func::cust(Alias::new("pg_database_size"))
                    .arg(Func::cust(Alias::new("current_database"))),
                Alias::new("bytes"),
            ),
        )
        .await?
        .try_get("", "bytes")?;
        u64::try_from(bytes).map_err(|_| Error::Invalid("database size is negative"))
    }

    /// Vacuum only the history tables affected by manual cleanup.
    ///
    /// FULL rewrites tables under exclusive locks and needs additional disk
    /// space. Ordinary VACUUM makes dead space reusable, usually without reducing
    /// the database's allocated size. Each statement runs outside a transaction.
    ///
    /// # Errors
    /// Returns database errors; already completed table vacuums remain committed.
    pub async fn vacuum_history(&self, full: bool) -> Result<()> {
        // SeaQuery has no VACUUM builder. These statements contain only fixed
        // repository-owned identifiers, never operator-provided SQL or paths.
        let statements = if full {
            [
                "VACUUM (FULL, ANALYZE) cp_events",
                "VACUUM (FULL, ANALYZE) cp_commands",
                "VACUUM (FULL, ANALYZE) cp_sessions",
                "VACUUM (FULL, ANALYZE) cp_search_documents",
                "VACUUM (FULL, ANALYZE) cp_search_entries",
                "VACUUM (FULL, ANALYZE) cp_search_progress",
            ]
        } else {
            [
                "VACUUM (ANALYZE) cp_events",
                "VACUUM (ANALYZE) cp_commands",
                "VACUUM (ANALYZE) cp_sessions",
                "VACUUM (ANALYZE) cp_search_documents",
                "VACUUM (ANALYZE) cp_search_entries",
                "VACUUM (ANALYZE) cp_search_progress",
            ]
        };
        for statement in statements {
            self.db.execute_unprepared(statement).await?;
        }
        Ok(())
    }
}
