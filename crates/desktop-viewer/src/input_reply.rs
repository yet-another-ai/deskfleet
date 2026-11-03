//! The input channel opening does not mean the remote OS controller is ready.

use serde::Deserialize;

use crate::Error;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Reply {
    Ready,
    Error { error: String },
}

pub(crate) fn ready(data: &[u8], is_string: bool) -> Result<(), Error> {
    if !is_string {
        return Err("invalid binary desktop input response".into());
    }
    match serde_json::from_slice::<Reply>(data)? {
        Reply::Ready => Ok(()),
        Reply::Error { error } => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_ready_and_preserves_remote_errors() {
        assert!(ready(br#"{"type":"ready"}"#, true).is_ok());
        let error = ready(br#"{"type":"error","error":"access denied"}"#, true).unwrap_err();
        assert_eq!(error.to_string(), "access denied");
        for data in [
            br#"{"type":"unknown"}"#.as_slice(),
            br#"{"type":"error"}"#,
            b"invalid",
        ] {
            assert!(ready(data, true).is_err());
        }
        assert!(ready(br#"{"type":"ready"}"#, false).is_err());
    }
}
