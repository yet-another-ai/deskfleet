use sea_orm::{ConnectionTrait, DbBackend, QueryResult, Statement, Value};
use serde::{Serialize, de::DeserializeOwned};

use crate::StoreError;

pub(super) fn statement(sql: impl Into<String>, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Sqlite, sql, values)
}

pub(super) async fn records<T: DeserializeOwned>(
    db: &impl ConnectionTrait,
    sql: impl Into<String>,
    values: Vec<Value>,
) -> Result<Vec<T>, StoreError> {
    db.query_all_raw(statement(sql, values))
        .await?
        .into_iter()
        .map(decode_record)
        .collect()
}

pub(super) async fn record<T: DeserializeOwned>(
    db: &impl ConnectionTrait,
    sql: impl Into<String>,
    values: Vec<Value>,
) -> Result<Option<T>, StoreError> {
    db.query_one_raw(statement(sql, values))
        .await?
        .map(decode_record)
        .transpose()
}

fn decode_record<T: DeserializeOwned>(row: QueryResult) -> Result<T, StoreError> {
    let json: String = row.try_get("", "record_json")?;
    Ok(serde_json::from_str(&json)?)
}

/// Table and column names come only from this module's fixed schema, never JSON.
pub(super) async fn upsert<T: Serialize>(
    db: &impl ConnectionTrait,
    table: &'static str,
    keys: &[&str],
    fields: &[(&str, Value)],
    record: &T,
) -> Result<(), StoreError> {
    let mut columns: Vec<_> = fields.iter().map(|(name, _)| *name).collect();
    columns.push("record_json");
    let mut values: Vec<_> = fields.iter().map(|(_, value)| value.clone()).collect();
    values.push(serde_json::to_string(record)?.into());
    let updates = columns
        .iter()
        .filter(|column| !keys.contains(column))
        .map(|column| format!("{column} = excluded.{column}"))
        .collect::<Vec<_>>()
        .join(", ");
    let parameters = vec!["?"; columns.len()].join(", ");
    db.execute_raw(statement(
        format!(
            "INSERT INTO {table} ({}) VALUES ({parameters}) \
             ON CONFLICT ({}) DO UPDATE SET {updates}",
            columns.join(", "),
            keys.join(", "),
        ),
        values,
    ))
    .await?;
    Ok(())
}

pub(super) fn positive(value: i64) -> Result<i64, StoreError> {
    if value <= 0 {
        return Err(StoreError::InvalidAgent("IDs must be positive"));
    }
    Ok(value)
}

pub(super) fn generation(value: u64) -> Result<i64, StoreError> {
    positive(
        i64::try_from(value).map_err(|_| StoreError::InvalidAgent("generation is out of range"))?,
    )
}
