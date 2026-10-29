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
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=5",
            vec![],
        ))
        .await?
        .is_none()
    {
        tx.execute_unprepared(include_str!("realtime.sql")).await?;
        tx.execute_unprepared(include_str!("peer_negotiations.sql"))
            .await?;
        tx.execute_unprepared("INSERT INTO cp_migrations (version) VALUES (5)")
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=6",
            vec![],
        ))
        .await?
        .is_none()
    {
        tx.execute_unprepared(include_str!("identity_performance.sql"))
            .await?;
        tx.execute_unprepared(include_str!("billing_performance.sql"))
            .await?;
        tx.execute_unprepared(include_str!("history_performance.sql"))
            .await?;
        tx.execute_unprepared("INSERT INTO cp_migrations (version) VALUES (6)")
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=7",
            vec![],
        ))
        .await?
        .is_none()
    {
        tx.execute_unprepared(include_str!("site_terms.sql"))
            .await?;
        tx.execute_unprepared("INSERT INTO cp_migrations (version) VALUES (7)")
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=8",
            vec![],
        ))
        .await?
        .is_none()
    {
        tx.execute_unprepared(
            "UPDATE cp_site_settings SET site_name='DeskFleet' WHERE singleton AND site_name='deskfleet'",
        )
        .await?;
        tx.execute_unprepared("INSERT INTO cp_migrations (version) VALUES (8)")
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=9",
            vec![],
        ))
        .await?
        .is_none()
    {
        tx.execute_unprepared(include_str!("billing_annual.sql"))
            .await?;
        tx.execute_unprepared("INSERT INTO cp_migrations (version) VALUES (9)")
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=10",
            vec![],
        ))
        .await?
        .is_none()
    {
        tx.execute_unprepared(include_str!("billing_analytics.sql"))
            .await?;
        tx.execute_unprepared("INSERT INTO cp_migrations (version) VALUES (10)")
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=11",
            vec![],
        ))
        .await?
        .is_none()
    {
        tx.execute_unprepared(include_str!("peer_transport.sql"))
            .await?;
        tx.execute_unprepared("INSERT INTO cp_migrations (version) VALUES (11)")
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=12",
            vec![],
        ))
        .await?
        .is_none()
    {
        tx.execute_unprepared(include_str!("team_owner.sql"))
            .await?;
        tx.execute_unprepared("INSERT INTO cp_migrations (version) VALUES (12)")
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
            "SELECT version FROM cp_migrations WHERE version=12",
            vec![],
        ))
        .await?
        .is_some()
    {
        tx.execute_unprepared(include_str!("team_owner_down.sql"))
            .await?;
        tx.execute_unprepared("DELETE FROM cp_migrations WHERE version=12")
            .await?;
    }
    tx.execute_unprepared("DELETE FROM cp_migrations WHERE version=11")
        .await?;
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=10",
            vec![],
        ))
        .await?
        .is_some()
    {
        tx.execute_unprepared(include_str!("billing_analytics_down.sql"))
            .await?;
        tx.execute_unprepared("DELETE FROM cp_migrations WHERE version=10")
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=9",
            vec![],
        ))
        .await?
        .is_some()
    {
        tx.execute_unprepared(include_str!("billing_annual_down.sql"))
            .await?;
        tx.execute_unprepared("DELETE FROM cp_migrations WHERE version=9")
            .await?;
    }
    tx.execute_unprepared("DELETE FROM cp_migrations WHERE version=8")
        .await?;
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=7",
            vec![],
        ))
        .await?
        .is_some()
    {
        tx.execute_unprepared(include_str!("site_terms_down.sql"))
            .await?;
        tx.execute_unprepared("DELETE FROM cp_migrations WHERE version=7")
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=6",
            vec![],
        ))
        .await?
        .is_some()
    {
        tx.execute_unprepared(include_str!("history_performance_down.sql"))
            .await?;
        tx.execute_unprepared(include_str!("billing_performance_down.sql"))
            .await?;
        tx.execute_unprepared(include_str!("identity_performance_down.sql"))
            .await?;
    }
    if tx
        .query_one_raw(sql(
            "SELECT version FROM cp_migrations WHERE version=5",
            vec![],
        ))
        .await?
        .is_some()
    {
        tx.execute_unprepared(include_str!("peer_negotiations_down.sql"))
            .await?;
        tx.execute_unprepared(include_str!("realtime_down.sql"))
            .await?;
    }
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
