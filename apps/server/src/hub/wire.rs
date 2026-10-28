//! Internal envelopes only; these do not change the public protocol.
use crate::error::{ApiError, Result};
use deskfleet_protocol::control::{ControlMessage, PeerAuthorization};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize)]
pub(super) enum Audience {
    Login(String),
    Users(Vec<String>),
    Machine(String),
}
#[derive(Serialize, Deserialize)]
pub(super) enum Envelope {
    Request {
        source: String,
        machine_id: String,
        connection_id: String,
        expires_at: i64,
        message: ControlMessage,
    },
    Response {
        id: String,
        machine_id: String,
        connection_id: String,
        result: WireResult,
    },
    Notify {
        audience: Audience,
        message: ControlMessage,
    },
    Revoke {
        peers: Vec<PeerAuthorization>,
        reason: String,
    },
    Disconnect {
        audience: Audience,
    },
    Replace {
        machine_id: String,
        connection_id: String,
    },
}
#[derive(Serialize, Deserialize)]
pub(super) enum WireResult {
    Ok(Value),
    Error {
        status: u16,
        code: String,
        message: String,
        reason: Option<String>,
    },
}
impl From<Result<Value>> for WireResult {
    fn from(value: Result<Value>) -> Self {
        match value {
            Ok(value) => Self::Ok(value),
            Err(error) => Self::Error {
                status: error.status.as_u16(),
                code: error.code.into_owned(),
                message: error.message,
                reason: error.reason,
            },
        }
    }
}
impl WireResult {
    pub(super) fn into_result(self) -> Result<Value> {
        match self {
            Self::Ok(value) => Ok(value),
            Self::Error {
                status,
                code,
                message,
                reason,
            } => Err(ApiError {
                status: actix_web::http::StatusCode::from_u16(status)
                    .map_err(|_| ApiError::internal())?,
                code: code.into(),
                message,
                reason,
            }),
        }
    }
}
