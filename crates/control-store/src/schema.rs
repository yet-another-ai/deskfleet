//! Historical DDL remains static SQL: migrations include PostgreSQL functions,
//! triggers, generated columns, and ordered data backfills. Runtime queries and
//! the migration ledger use typed schema identifiers.
use crate::{Result, entities::cp_migrations as migrations};
use sea_orm::sea_query::{Alias, ColumnDef, Expr, ExprTrait, Func, Order, Query, Table};
use sea_orm::{ConnectionTrait, DatabaseConnection, EntityName, TransactionTrait};

pub async fn migrate(db: &DatabaseConnection) -> Result<()> {
    let tx = db.begin().await?;
    tx.execute(
        Query::select()
            .expr(Func::cust(Alias::new("pg_advisory_xact_lock")).arg(Expr::val(761946021_i64))),
    )
    .await?;
    tx.execute(
        Table::create()
            .table(migrations::Entity)
            .if_not_exists()
            .col(
                ColumnDef::new(migrations::Column::Version)
                    .integer()
                    .primary_key(),
            ),
    )
    .await?;
    if !version_present(&tx, 1).await? {
        tx.execute_unprepared(include_str!("schema.sql")).await?;
        record_version(&tx, 1).await?;
    }
    if !version_present(&tx, 2).await? {
        tx.execute_unprepared(include_str!("turn_usage.sql"))
            .await?;
        record_version(&tx, 2).await?;
    }
    if !version_present(&tx, 3).await? {
        tx.execute_unprepared(include_str!("site.sql")).await?;
        record_version(&tx, 3).await?;
    }
    if !version_present(&tx, 4).await? {
        tx.execute_unprepared(include_str!("billing.sql")).await?;
        record_version(&tx, 4).await?;
    }
    if !version_present(&tx, 5).await? {
        tx.execute_unprepared(include_str!("realtime.sql")).await?;
        tx.execute_unprepared(include_str!("peer_negotiations.sql"))
            .await?;
        record_version(&tx, 5).await?;
    }
    if !version_present(&tx, 6).await? {
        tx.execute_unprepared(include_str!("identity_performance.sql"))
            .await?;
        tx.execute_unprepared(include_str!("billing_performance.sql"))
            .await?;
        tx.execute_unprepared(include_str!("history_performance.sql"))
            .await?;
        record_version(&tx, 6).await?;
    }
    if !version_present(&tx, 7).await? {
        tx.execute_unprepared(include_str!("site_terms.sql"))
            .await?;
        record_version(&tx, 7).await?;
    }
    if !version_present(&tx, 8).await? {
        tx.execute_unprepared(
            "UPDATE cp_site_settings SET site_name='DeskFleet' WHERE singleton AND site_name='deskfleet'",
        )
        .await?;
        record_version(&tx, 8).await?;
    }
    if !version_present(&tx, 9).await? {
        tx.execute_unprepared(include_str!("billing_annual.sql"))
            .await?;
        record_version(&tx, 9).await?;
    }
    if !version_present(&tx, 10).await? {
        tx.execute_unprepared(include_str!("billing_analytics.sql"))
            .await?;
        record_version(&tx, 10).await?;
    }
    if !version_present(&tx, 11).await? {
        tx.execute_unprepared(include_str!("peer_transport.sql"))
            .await?;
        record_version(&tx, 11).await?;
    }
    if !version_present(&tx, 12).await? {
        tx.execute_unprepared(include_str!("team_owner.sql"))
            .await?;
        record_version(&tx, 12).await?;
    }
    if !version_present(&tx, 13).await? {
        tx.execute_unprepared("CREATE TABLE cp_github_identities (subject TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES cp_users(id))").await?;
        record_version(&tx, 13).await?;
    }
    if !version_present(&tx, 14).await? {
        tx.execute_unprepared("CREATE SEQUENCE cp_authentication_generation")
            .await?;
        tx.execute_unprepared(
            "ALTER TABLE cp_users ADD COLUMN authentication_generation BIGINT NOT NULL DEFAULT 0",
        )
        .await?;
        record_version(&tx, 14).await?;
    }
    if !version_present(&tx, 15).await? {
        tx.execute_unprepared(include_str!("github_app.sql"))
            .await?;
        record_version(&tx, 15).await?;
    }
    if !version_present(&tx, 16).await? {
        tx.execute_unprepared(include_str!("session_activity.sql"))
            .await?;
        record_version(&tx, 16).await?;
    }
    if !version_present(&tx, 17).await? {
        tx.execute_unprepared("CREATE TABLE cp_google_identities (subject TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES cp_users(id))").await?;
        record_version(&tx, 17).await?;
    }
    if !version_present(&tx, 18).await? {
        tx.execute_unprepared(include_str!("ai_usage/projection.sql"))
            .await?;
        record_version(&tx, 18).await?;
    }
    if !version_present(&tx, 19).await? {
        tx.execute_unprepared(include_str!("search/schema.sql"))
            .await?;
        record_version(&tx, 19).await?;
    }
    if !version_present(&tx, 20).await? {
        tx.execute_unprepared(include_str!("turn_settings.sql"))
            .await?;
        record_version(&tx, 20).await?;
    }
    if !version_present(&tx, 21).await? {
        tx.execute_unprepared(include_str!("team_turn.sql")).await?;
        record_version(&tx, 21).await?;
    }
    if !version_present(&tx, 22).await? {
        tx.execute_unprepared(include_str!("machine_registrations.sql"))
            .await?;
        crate::search::backfill(&tx).await?;
        record_version(&tx, 22).await?;
    }
    if !version_present(&tx, 23).await? {
        tx.execute_unprepared(include_str!("cloudflare_turn.sql"))
            .await?;
        record_version(&tx, 23).await?;
    }
    if !version_present(&tx, 24).await? {
        tx.execute_unprepared(include_str!("signaling_budgets.sql"))
            .await?;
        record_version(&tx, 24).await?;
    }
    if !version_present(&tx, 25).await? {
        tx.execute_unprepared(include_str!("peer_budgets.sql"))
            .await?;
        record_version(&tx, 25).await?;
    }
    if !version_present(&tx, 26).await? {
        tx.execute_unprepared(include_str!("history_event_original.sql"))
            .await?;
        record_version(&tx, 26).await?;
    }
    if !version_present(&tx, 27).await? {
        tx.execute_unprepared(include_str!("turn_usage_peer_retention.sql"))
            .await?;
        record_version(&tx, 27).await?;
    }
    if !version_present(&tx, 28).await? {
        tx.execute_unprepared(include_str!("history_retention.sql"))
            .await?;
        record_version(&tx, 28).await?;
    }
    if !version_present(&tx, 29).await? {
        tx.execute_unprepared(include_str!("turn_usage_compaction.sql"))
            .await?;
        record_version(&tx, 29).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Revert the central schema. This permanently drops all central records.
pub async fn down(db: &DatabaseConnection) -> Result<()> {
    let tx = db.begin().await?;
    tx.execute(
        Query::select()
            .expr(Func::cust(Alias::new("pg_advisory_xact_lock")).arg(Expr::val(761946021_i64))),
    )
    .await?;
    if version_present(&tx, 29).await? {
        tx.execute_unprepared(include_str!("turn_usage_compaction_down.sql"))
            .await?;
        remove_version(&tx, 29).await?;
    }
    if version_present(&tx, 28).await? {
        tx.execute_unprepared(include_str!("history_retention_down.sql"))
            .await?;
        remove_version(&tx, 28).await?;
    }
    if version_present(&tx, 27).await? {
        tx.execute_unprepared(include_str!("turn_usage_peer_retention_down.sql"))
            .await?;
        remove_version(&tx, 27).await?;
    }
    if version_present(&tx, 26).await? {
        tx.execute_unprepared(include_str!("history_event_original_down.sql"))
            .await?;
        remove_version(&tx, 26).await?;
    }
    if version_present(&tx, 25).await? {
        tx.execute_unprepared(include_str!("peer_budgets_down.sql"))
            .await?;
        remove_version(&tx, 25).await?;
    }
    if version_present(&tx, 24).await? {
        tx.execute_unprepared(include_str!("signaling_budgets_down.sql"))
            .await?;
        remove_version(&tx, 24).await?;
    }
    if version_present(&tx, 23).await? {
        tx.execute_unprepared(include_str!("cloudflare_turn_down.sql"))
            .await?;
        remove_version(&tx, 23).await?;
    }
    if version_present(&tx, 22).await? {
        tx.execute_unprepared(include_str!("machine_registrations_down.sql"))
            .await?;
        remove_version(&tx, 22).await?;
    }
    if version_present(&tx, 21).await? {
        tx.execute_unprepared(include_str!("team_turn_down.sql"))
            .await?;
        remove_version(&tx, 21).await?;
    }
    if version_present(&tx, 20).await? {
        tx.execute_unprepared(include_str!("turn_settings_down.sql"))
            .await?;
        remove_version(&tx, 20).await?;
    }
    if version_present(&tx, 19).await? {
        tx.execute_unprepared(include_str!("search/schema_down.sql"))
            .await?;
        remove_version(&tx, 19).await?;
    }
    if version_present(&tx, 18).await? {
        tx.execute_unprepared(include_str!("ai_usage/projection_down.sql"))
            .await?;
        remove_version(&tx, 18).await?;
    }
    if version_present(&tx, 17).await? {
        tx.execute_unprepared("DROP TABLE cp_google_identities")
            .await?;
        remove_version(&tx, 17).await?;
    }
    if version_present(&tx, 15).await? {
        tx.execute_unprepared("DROP TABLE cp_github_app_authorizations")
            .await?;
        remove_version(&tx, 15).await?;
    }
    if version_present(&tx, 14).await? {
        tx.execute_unprepared("ALTER TABLE cp_users DROP COLUMN authentication_generation")
            .await?;
        tx.execute_unprepared("DROP SEQUENCE cp_authentication_generation")
            .await?;
        remove_version(&tx, 14).await?;
    }
    if version_present(&tx, 13).await? {
        tx.execute_unprepared("DROP TABLE cp_github_identities")
            .await?;
        remove_version(&tx, 13).await?;
    }
    if version_present(&tx, 12).await? {
        tx.execute_unprepared(include_str!("team_owner_down.sql"))
            .await?;
        remove_version(&tx, 12).await?;
    }
    remove_version(&tx, 11).await?;
    if version_present(&tx, 10).await? {
        tx.execute_unprepared(include_str!("billing_analytics_down.sql"))
            .await?;
        remove_version(&tx, 10).await?;
    }
    if version_present(&tx, 9).await? {
        tx.execute_unprepared(include_str!("billing_annual_down.sql"))
            .await?;
        remove_version(&tx, 9).await?;
    }
    remove_version(&tx, 8).await?;
    if version_present(&tx, 7).await? {
        tx.execute_unprepared(include_str!("site_terms_down.sql"))
            .await?;
        remove_version(&tx, 7).await?;
    }
    if version_present(&tx, 6).await? {
        tx.execute_unprepared(include_str!("history_performance_down.sql"))
            .await?;
        tx.execute_unprepared(include_str!("billing_performance_down.sql"))
            .await?;
        tx.execute_unprepared(include_str!("identity_performance_down.sql"))
            .await?;
        remove_version(&tx, 6).await?;
    }
    if version_present(&tx, 5).await? {
        tx.execute_unprepared(include_str!("peer_negotiations_down.sql"))
            .await?;
        tx.execute_unprepared(include_str!("realtime_down.sql"))
            .await?;
    }
    if version_present(&tx, 4).await? {
        tx.execute_unprepared(include_str!("billing_down.sql"))
            .await?;
    }
    if version_present(&tx, 3).await? {
        tx.execute_unprepared(include_str!("site_down.sql")).await?;
    }
    if version_present(&tx, 2).await? {
        tx.execute_unprepared(include_str!("turn_usage_down.sql"))
            .await?;
    }
    if version_present(&tx, 1).await? {
        tx.execute_unprepared(include_str!("schema_down.sql"))
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn version_present(db: &impl ConnectionTrait, version: i32) -> Result<bool> {
    Ok(db
        .query_one(
            Query::select()
                .column(migrations::Column::Version)
                .from(migrations::Entity)
                .and_where(Expr::col(migrations::Column::Version).eq(version)),
        )
        .await?
        .is_some())
}
async fn record_version(db: &impl ConnectionTrait, version: i32) -> Result<()> {
    db.execute(
        Query::insert()
            .into_table(migrations::Entity)
            .columns([migrations::Column::Version])
            .values_panic([version.into()]),
    )
    .await?;
    Ok(())
}
async fn remove_version(db: &impl ConnectionTrait, version: i32) -> Result<()> {
    db.execute(
        Query::delete()
            .from_table(migrations::Entity)
            .and_where(Expr::col(migrations::Column::Version).eq(version)),
    )
    .await?;
    Ok(())
}

/// List applied migrations, or return `None` before the migration ledger exists.
///
/// # Errors
/// Returns database errors when the ledger cannot be inspected.
pub async fn applied_versions(db: &DatabaseConnection) -> Result<Option<Vec<i32>>> {
    let exists: bool = crate::one_query(
        db,
        Query::select().expr_as(
            Expr::expr(
                Func::cust(Alias::new("to_regclass"))
                    .arg(Expr::val(migrations::Entity.table_name())),
            )
            .is_not_null(),
            Alias::new("present"),
        ),
    )
    .await?
    .try_get("", "present")?;
    if !exists {
        return Ok(None);
    }
    Ok(Some(
        db.query_all(
            Query::select()
                .column(migrations::Column::Version)
                .from(migrations::Entity)
                .order_by(migrations::Column::Version, Order::Asc),
        )
        .await?
        .into_iter()
        .map(|row| row.try_get("", "version").map_err(crate::Error::from))
        .collect::<Result<_>>()?,
    ))
}
