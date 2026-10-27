use crate::{Result, sql};
use sea_orm::{ConnectionTrait, DatabaseConnection, TransactionTrait};

pub async fn migrate(db: &DatabaseConnection) -> Result<()> {
    let tx = db.begin().await?;
    tx.execute_unprepared("SELECT pg_advisory_xact_lock(761946021)")
        .await?;
    tx.execute_unprepared("CREATE TABLE IF NOT EXISTS cp_migrations (version INTEGER PRIMARY KEY)")
        .await?;
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version = 1",
            vec![],
        ))
        .await?
        .is_none()
    {
        tx.execute_unprepared(include_str!("schema.sql")).await?;
        tx.execute_unprepared("INSERT INTO cp_migrations (version) VALUES (1)")
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version = 2",
            vec![],
        ))
        .await?
        .is_none()
    {
        tx.execute_unprepared(include_str!("turn_usage.sql"))
            .await?;
        tx.execute_unprepared("INSERT INTO cp_migrations (version) VALUES (2)")
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version = 3",
            vec![],
        ))
        .await?
        .is_none()
    {
        tx.execute_unprepared(include_str!("site.sql")).await?;
        tx.execute_unprepared("INSERT INTO cp_migrations (version) VALUES (3)")
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=4",
            vec![],
        ))
        .await?
        .is_none()
    {
        tx.execute_unprepared(include_str!("billing.sql")).await?;
        tx.execute_unprepared("INSERT INTO cp_migrations (version) VALUES (4)")
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Revert the central schema. This permanently drops all central records.
pub async fn down(db: &DatabaseConnection) -> Result<()> {
    let tx = db.begin().await?;
    tx.execute_unprepared("SELECT pg_advisory_xact_lock(761946021)")
        .await?;
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=4",
            vec![],
        ))
        .await?
        .is_some()
    {
        tx.execute_unprepared(include_str!("billing_down.sql"))
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=3",
            vec![],
        ))
        .await?
        .is_some()
    {
        tx.execute_unprepared(include_str!("site_down.sql")).await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=2",
            vec![],
        ))
        .await?
        .is_some()
    {
        tx.execute_unprepared(include_str!("turn_usage_down.sql"))
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=1",
            vec![],
        ))
        .await?
        .is_some()
    {
        tx.execute_unprepared(include_str!("schema_down.sql"))
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
