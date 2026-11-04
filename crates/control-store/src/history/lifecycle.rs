use crate::entities::{
    cp_catalogs as catalogs, cp_machine_registrations as registrations, cp_sessions as sessions,
};
use crate::{Error, Result, now_ms, one_query};
use sea_orm::{
    ConnectionTrait,
    sea_query::{BinOper, Expr, ExprTrait, Query, SelectStatement},
};
use serde_json::Value;

/// Catalog replacement and history ingestion share the registration lock, so a
/// late upload cannot race the deletion marker or create a removed Session.
pub(super) async fn lock_registration(db: &impl ConnectionTrait, registration: i64) -> Result<()> {
    one_query(
        db,
        Query::select()
            .column(registrations::Column::Id)
            .from(registrations::Entity)
            .and_where(Expr::col(registrations::Column::Id).eq(registration))
            .lock_exclusive(),
    )
    .await?;
    Ok(())
}

pub(super) async fn mark_removed(
    db: &impl ConnectionTrait,
    registration: i64,
    snapshot: &Value,
) -> Result<()> {
    // Only an explicit complete inventory is authoritative for deletion.
    let Some(ids) = snapshot.get("sessionIds") else {
        return Ok(());
    };
    if !ids
        .as_array()
        .is_some_and(|ids| ids.iter().all(Value::is_string))
    {
        return Err(Error::Invalid("invalid Session inventory"));
    }
    db.execute(
        Query::update()
            .table(sessions::Entity)
            .value(sessions::Column::DeletedAt, now_ms())
            .and_where(Expr::col(sessions::Column::RegistrationId).eq(registration))
            .and_where(Expr::col(sessions::Column::DeletedAt).is_null())
            // SeaQuery does not expose PostgreSQL's JSONB key-existence operator.
            .and_where(
                Expr::val(ids.clone())
                    .cast_as("jsonb")
                    .binary(BinOper::Custom("?"), Expr::col(sessions::Column::SessionId))
                    .not(),
            ),
    )
    .await?;
    Ok(())
}

pub(super) async fn require_inventory(
    db: &impl ConnectionTrait,
    registration: i64,
    session: &str,
) -> Result<()> {
    let row = db
        .query_one(
            Query::select()
                .column(catalogs::Column::Snapshot)
                .from(catalogs::Entity)
                .and_where(Expr::col(catalogs::Column::RegistrationId).eq(registration)),
        )
        .await?;
    if let Some(row) = row {
        let snapshot: Value = row.try_get("", "snapshot")?;
        if snapshot
            .get("sessionIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| !ids.iter().any(|id| id.as_str() == Some(session)))
        {
            return Err(Error::NotFound);
        }
    }
    Ok(())
}

pub(super) fn active_session(
    registration: i64,
    session: sea_orm::sea_query::Expr,
) -> SelectStatement {
    Query::select()
        .expr(Expr::val(1))
        .from(sessions::Entity)
        .and_where(Expr::col(sessions::Column::RegistrationId).eq(registration))
        .and_where(Expr::col(sessions::Column::SessionId).eq(session))
        .and_where(Expr::col(sessions::Column::DeletedAt).is_null())
        .to_owned()
}
