//! Mux is available only when both this API and the registered daemon support it.

use crate::error::{ApiError, Result};
use actix_web::http::StatusCode;
use deskfleet_protocol::control::PeerTransport;
use serde_json::{Value, json};

pub(super) const PROFILE: &str = "fixed4-v1";

/// The server marker is derived, never accepted from a daemon's catalog payload.
pub(crate) fn advertise(capabilities: &mut Value) {
    let Some(capabilities) = capabilities.as_object_mut() else {
        return;
    };
    capabilities.remove("muxServer");
    if capabilities.get("mux").and_then(Value::as_str) == Some(PROFILE) {
        capabilities.insert("muxServer".into(), json!(PROFILE));
    }
}

pub(super) fn actions(capabilities: &Value, transport: PeerTransport) -> Result<Vec<&'static str>> {
    if transport != PeerTransport::Webrtc
        || capabilities.get("mux").and_then(Value::as_str) != Some(PROFILE)
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "mux_unsupported",
            "target does not support the fixed4-v1 mux transport",
        ));
    }
    Ok(vec![
        "agent:read",
        "agent:execute",
        "git:read",
        "terminal:read",
        "terminal:write",
        "files:read",
        "files:write",
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_confirms_only_the_supported_daemon_profile() {
        for profile in [None, Some("unknown"), Some(PROFILE)] {
            let mut capabilities = json!({"terminal": true, "muxServer": PROFILE});
            if let Some(profile) = profile {
                capabilities["mux"] = json!(profile);
            }
            advertise(&mut capabilities);
            assert_eq!(capabilities["terminal"], true);
            assert_eq!(
                capabilities.get("muxServer"),
                (profile == Some(PROFILE)).then_some(&json!(PROFILE)),
            );
        }
    }

    #[test]
    fn unsupported_daemons_and_local_transports_cannot_receive_mux_grants() {
        for capabilities in [Value::Null, json!({}), json!({"mux": "unknown"})] {
            assert_eq!(
                actions(&capabilities, PeerTransport::Webrtc)
                    .unwrap_err()
                    .code,
                "mux_unsupported",
            );
        }
        let capabilities = json!({"mux": PROFILE});
        assert!(actions(&capabilities, PeerTransport::Local).is_err());
        let granted = actions(&capabilities, PeerTransport::Webrtc).unwrap();
        assert!(granted.contains(&"terminal:write"));
        assert!(granted.contains(&"files:read"));
        assert!(!granted.contains(&"desktop:control"));
        assert!(!granted.contains(&"ports:forward"));
    }
}
