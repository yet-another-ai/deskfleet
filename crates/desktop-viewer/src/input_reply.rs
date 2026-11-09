//! The input channel opening does not mean the remote OS controller is ready.

use serde::Deserialize;

use crate::Error;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Reply {
    Ready,
    Error {
        error: String,
    },
    Configured {
        #[serde(rename = "requestId")]
        request_id: u64,
        control: bool,
    },
    ConfigurationError {
        #[serde(rename = "requestId")]
        request_id: u64,
        control: bool,
        error: String,
    },
}

pub(crate) fn parse(data: &[u8], is_string: bool) -> Result<Reply, Error> {
    if !is_string {
        return Err("invalid binary desktop input response".into());
    }
    Ok(serde_json::from_slice(data)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_ready_and_preserves_remote_errors() {
        assert!(parse(br#"{"type":"ready"}"#, true).is_ok());
        let error = parse(br#"{"type":"error","error":"access denied"}"#, true).unwrap();
        assert!(matches!(error, Reply::Error { error } if error == "access denied"));
        for data in [
            br#"{"type":"unknown"}"#.as_slice(),
            br#"{"type":"error"}"#,
            b"invalid",
        ] {
            assert!(parse(data, true).is_err());
        }
        assert!(parse(br#"{"type":"ready"}"#, false).is_err());
    }
}
