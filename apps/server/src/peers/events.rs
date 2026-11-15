//! Admit small, known peer events before spawning asynchronous negotiation work.
use crate::error::{ApiError, Result};
use serde::Deserialize;
use serde_json::Value;

pub const MAX_BYTES: usize = 24 * 1024;

/// Shape validation is synchronous; bounded dispatch owns overload handling.
/// A burst is not evidence that the authenticated Machine has disconnected.
pub fn admit(wire_bytes: usize, event: &Value) -> bool {
    wire_bytes <= 32 * 1024 && validate(event).is_ok()
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Event {
    IceCandidate {
        candidate: Value,
    },
    StateChanged {
        state: String,
    },
    Error {
        error: String,
        reason: Option<String>,
    },
}

pub fn validate(event: &Value) -> Result<()> {
    if serde_json::to_vec(event)
        .map_err(|_| ApiError::bad("invalid peer event"))?
        .len()
        > MAX_BYTES
    {
        return Err(ApiError::bad("peer event too large"));
    }
    match serde_json::from_value(event.clone()).map_err(|_| ApiError::bad("invalid peer event"))? {
        Event::IceCandidate { candidate } => {
            deskfleet_control_store::signaling_limits::candidate(&candidate)?
        }
        Event::StateChanged { state }
            if matches!(
                state.as_str(),
                "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed"
            ) => {}
        Event::Error { error, reason }
            if error.len() <= 2048
                && reason
                    .as_deref()
                    .is_none_or(|r| matches!(r, "encoder" | "accessibility")) => {}
        _ => return Err(ApiError::bad("invalid peer event fields")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn oversized_or_unknown_events_do_not_poison_a_later_valid_burst() {
        let error = json!({"kind":"error","error":"native diagnostic".repeat(1024)});
        assert!(!admit(32_769, &error));
        assert!(!admit(
            4096,
            &json!({"kind":"error","error":"x".repeat(2049)})
        ));
        for _ in 0..80 {
            assert!(!admit(64, &json!({"kind":"unknown"})));
            assert!(admit(64, &json!({"kind":"stateChanged","state":"closed"})));
        }
    }

    #[test]
    fn accepts_only_bounded_known_events() {
        assert!(validate(&json!({"kind":"stateChanged","state":"closed"})).is_ok());
        assert!(validate(&json!({"kind":"stateChanged","state":"closed","extra":"x"})).is_err());
        assert!(validate(&json!({"kind":"error","error":"x".repeat(2049)})).is_err());
        assert!(validate(&json!({"kind":"other"})).is_err());
    }
}
