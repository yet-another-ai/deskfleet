//! Transport-independent contracts shared by DeskFleet components.
//!
//! Until the first explicit protocol freeze, evolve contracts in place at version 1.

use serde::{Deserialize, Serialize};

pub use deskfleet_model as model;

/// Provisional wire-contract version.
pub const PROTOCOL_VERSION: u32 = 1;

/// Process liveness metadata. This does not imply database or service readiness.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub protocol_version: u32,
}

impl HealthResponse {
    pub fn ok(version: impl Into<String>) -> Self {
        Self {
            status: "ok".to_owned(),
            version: version.into(),
            protocol_version: PROTOCOL_VERSION,
        }
    }
}

/// Authenticated control-plane contracts.
pub mod control;
