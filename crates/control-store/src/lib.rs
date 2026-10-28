//! PostgreSQL control-plane storage. Independent from each daemon's SQLite catalog.
mod ai_usage;
pub mod billing;
mod history;
mod identity;
mod machines;
mod maintenance;
mod peer_negotiations;
mod peers;
pub mod policies;
mod realtime;
pub mod schema;
mod site;
mod teams;
mod turn_usage;

pub use identity::normalize_email;
pub use peer_negotiations::{PeerCandidateState, PeerOfferState};
pub use realtime::RealtimeRoute;
pub use turn_usage::{TurnUsage, TurnUsageSide};

use chrono::{SecondsFormat, Utc};
use deskfleet_protocol::control::{Machine, User};
use sea_orm::{
    ConnectionTrait, Database, DatabaseConnection, DbBackend, DbErr, QueryResult, Statement, Value,
};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("database operation failed")]
    Database(#[from] DbErr),
    #[error("authentication required")]
    Unauthorized,
    #[error("access denied")]
    Forbidden,
    #[error("resource not found")]
    NotFound,
    #[error("{0}")]
    Invalid(&'static str),
    #[error("{0}")]
    Conflict(&'static str),
    #[error("stored record is invalid")]
    Json(#[from] serde_json::Error),
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone)]
pub struct ControlStore {
    db: DatabaseConnection,
    hosted: bool,
}

#[derive(Clone, Debug)]
pub struct AuthSession {
    pub id: String,
    pub device_id: String,
    pub user: User,
}

#[derive(Clone, Debug)]
pub struct MachineAuth {
    pub machine: Machine,
}

impl ControlStore {
    pub async fn connect(url: &str) -> Result<Self> {
        if !url.starts_with("postgres://") && !url.starts_with("postgresql://") {
            return Err(Error::Invalid(
                "the central server requires a PostgreSQL DATABASE_URL",
            ));
        }
        let db = Database::connect(url).await?;
        schema::migrate(&db).await?;
        Ok(Self { db, hosted: false })
    }
    pub fn with_hosted_mode(mut self, hosted: bool) -> Self {
        self.hosted = hosted;
        self
    }
    pub fn database(&self) -> &DatabaseConnection {
        &self.db
    }
    pub async fn close(&self) -> Result<()> {
        self.db.close_by_ref().await?;
        Ok(())
    }
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}
pub fn timestamp(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn secret() -> String {
    format!(
        "df_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
pub fn secret_hash(token: &str) -> String {
    let mut encoded = String::with_capacity(64);
    for byte in Sha256::digest(token.as_bytes()) {
        write!(encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}
pub fn resource_id(id: &str) -> Result<i64> {
    id.parse::<i64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or(Error::Invalid("invalid resource identity"))
}
pub(crate) fn sql(text: &str, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, text, values)
}
pub(crate) async fn one(
    db: &impl ConnectionTrait,
    text: &str,
    values: Vec<Value>,
) -> Result<QueryResult> {
    db.query_one_raw(sql(text, values))
        .await?
        .ok_or(Error::NotFound)
}
pub(crate) async fn json_rows(
    db: &impl ConnectionTrait,
    text: &str,
    values: Vec<Value>,
) -> Result<Vec<Json>> {
    db.query_all_raw(sql(text, values))
        .await?
        .into_iter()
        .map(|row| row.try_get("", "record").map_err(Error::from))
        .collect()
}
pub(crate) fn name(value: &str) -> Result<&str> {
    let value = value.trim();
    if value.is_empty() || value.len() > 200 {
        Err(Error::Invalid("name must contain 1 to 200 bytes"))
    } else {
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn secret_hash_preserves_sha256_lowercase_hex() {
        for (token, expected) in [
            (
                "",
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ),
            (
                "abc",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
        ] {
            assert_eq!(super::secret_hash(token), expected);
        }
    }
}
