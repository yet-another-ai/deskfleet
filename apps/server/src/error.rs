//! Stable API failures; internal storage and credential details are never returned.
use actix_web::{HttpResponse, ResponseError, http::StatusCode};
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
            Error::Database(_) | Error::Json(_) => {
                tracing::error!("control-plane storage operation failed");
                Self::internal()
            }
        }
    }
}
