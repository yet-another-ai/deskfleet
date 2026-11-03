//! Admit small, known peer events before spawning asynchronous negotiation work.
use crate::error::{ApiError, Result};
use serde::Deserialize;
use serde_json::Value;
use std::time::{Duration, Instant};

pub const MAX_BYTES: usize = 24 * 1024;

pub enum Admission {
    Accept,
    Drop,
    Close,
}

pub fn admit(rate: &mut Rate, wire_bytes: usize, event: &Value) -> Admission {
    // Charge invalid events as well, so dropping them cannot bypass flood limits.
    if !rate.admit() {
        Admission::Close
    } else if wire_bytes > 32 * 1024 || validate(event).is_err() {
        Admission::Drop
    } else {
        Admission::Accept
    }
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

/// Cheap socket admission precedes the registration's shared database budget.
pub struct Rate {
    start: Instant,
    count: u32,
}
impl Rate {
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
            count: 0,
        }
    }
    pub fn admit(&mut self) -> bool {
        if self.start.elapsed() >= Duration::from_secs(1) {
            self.start = Instant::now();
            self.count = 0;
        }
        self.count += 1;
        self.count <= 64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn an_oversized_error_drops_only_that_event_and_still_charges_admission() {
        let mut rate = Rate::new();
        let error = json!({"kind":"error","error":"native diagnostic".repeat(1024)});
        assert!(matches!(admit(&mut rate, 32_769, &error), Admission::Drop));
        assert!(matches!(
            admit(
                &mut rate,
                4096,
                &json!({"kind":"error","error":"x".repeat(2049)})
            ),
            Admission::Drop
        ));
        let closed = json!({"kind":"stateChanged","state":"closed"});
        assert!(matches!(admit(&mut rate, 64, &closed), Admission::Accept));
        let unknown = json!({"kind":"unknown"});
        for _ in 3..64 {
            assert!(matches!(admit(&mut rate, 64, &unknown), Admission::Drop));
        }
        assert!(matches!(admit(&mut rate, 64, &closed), Admission::Close));
    }

    #[test]
    fn accepts_only_bounded_known_events() {
        assert!(validate(&json!({"kind":"stateChanged","state":"closed"})).is_ok());
        assert!(validate(&json!({"kind":"stateChanged","state":"closed","extra":"x"})).is_err());
        assert!(validate(&json!({"kind":"error","error":"x".repeat(2049)})).is_err());
        assert!(validate(&json!({"kind":"other"})).is_err());
        let mut rate = Rate::new();
        for _ in 0..64 {
            assert!(rate.admit());
        }
        assert!(!rate.admit());
    }
}
