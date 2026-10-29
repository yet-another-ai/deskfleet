//! Stable API failures; internal storage and credential details are never returned.
use actix_web::{HttpResponse, ResponseError, http::StatusCode};
use sea_orm::{ConnAcquireErr, DbErr, RuntimeErr, SqlxError};
use serde_json::json;
use std::borrow::Cow;
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{message}")]
pub struct ApiError {
    pub status: StatusCode,
    pub code: Cow<'static, str>,
    pub message: String,
    pub reason: Option<String>,
}
pub type Result<T> = std::result::Result<T, ApiError>;
impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            reason: None,
        }
    }
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }
    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "authentication required",
        )
    }
    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", "access denied")
    }
    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "server operation failed",
        )
    }
    pub fn unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "machine_offline",
            "target machine is unavailable",
        )
    }
}
impl ResponseError for ApiError {
    fn status_code(&self) -> StatusCode {
        self.status
    }
    fn error_response(&self) -> HttpResponse {
        let mut body = json!({"error": {"code": self.code, "message": self.message}});
        if self.reason.as_deref() == Some("encoder") {
            body["error"]["reason"] = json!("encoder");
        }
        HttpResponse::build(self.status).json(body)
    }
}
impl From<deskfleet_control_store::Error> for ApiError {
    fn from(error: deskfleet_control_store::Error) -> Self {
        use deskfleet_control_store::Error;
        match error {
            Error::Unauthorized => Self::unauthorized(),
            Error::Forbidden => Self::forbidden(),
            Error::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", "resource not found"),
            Error::Invalid(message) => Self::bad(message),
            Error::Conflict(message) => Self::new(StatusCode::CONFLICT, "conflict", message),
            Error::Database(error) => {
                log_database_error(&error);
                Self::internal()
            }
            Error::Json(error) => {
                log_json_error(&error);
                Self::internal()
            }
        }
    }
}

fn log_database_error(error: &DbErr) {
    let (phase, runtime) = match error {
        DbErr::Conn(runtime) => ("connection", Some(runtime)),
        DbErr::Exec(runtime) => ("execution", Some(runtime)),
        DbErr::Query(runtime) => ("query", Some(runtime)),
        DbErr::ConnectionAcquire(_) => ("connection_acquire", None),
        DbErr::TryIntoErr { .. } | DbErr::Type(_) | DbErr::Json(_) => ("decode", None),
        DbErr::Migration(_) => ("migration", None),
        _ => ("other", None),
    };
    let driver = runtime.and_then(|runtime| match runtime {
        RuntimeErr::SqlxError(error) => Some(error.as_ref()),
        _ => None,
    });
    let category = match (error, driver) {
        (DbErr::ConnectionAcquire(ConnAcquireErr::Timeout), _)
        | (_, Some(SqlxError::PoolTimedOut)) => "pool_timeout",
        (DbErr::ConnectionAcquire(ConnAcquireErr::ConnectionClosed), _)
        | (_, Some(SqlxError::PoolClosed)) => "pool_closed",
        (_, Some(SqlxError::Database(_))) => "database",
        (_, Some(SqlxError::Io(_))) => "io",
        (_, Some(SqlxError::Tls(_))) => "tls",
        (_, Some(SqlxError::Configuration(_))) => "configuration",
        (_, Some(SqlxError::ColumnDecode { .. } | SqlxError::Decode(_))) => "decode",
        (_, Some(SqlxError::Encode(_))) => "encode",
        (_, Some(SqlxError::ColumnNotFound(_) | SqlxError::ColumnIndexOutOfBounds { .. })) => {
            "column_not_found"
        }
        (_, Some(SqlxError::RowNotFound)) => "row_not_found",
        _ => "other",
    };
    let database = driver.and_then(SqlxError::as_database_error);
    // Driver messages and details can contain credentials, query parameters, or rows.
    tracing::error!(
        storage = "database",
        phase,
        category,
        sqlstate = database.and_then(|error| error.code()).as_deref(),
        table = database.and_then(|error| error.table()),
        constraint = database.and_then(|error| error.constraint()),
        "control-plane storage operation failed"
    );
}

fn log_json_error(error: &serde_json::Error) {
    // Serde's generic message can echo stored values. A missing field names the schema.
    let message = error.to_string();
    let missing_field = message
        .strip_prefix("missing field `")
        .and_then(|message| message.split_once('`'))
        .map(|(field, _)| field)
        .filter(|field| {
            !field.is_empty()
                && field
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        });
    tracing::error!(
        storage = "json",
        category = ?error.classify(),
        line = error.line(),
        column = error.column(),
        missing_field,
        "control-plane storage operation failed"
    );
}

#[cfg(test)]
mod tests;
