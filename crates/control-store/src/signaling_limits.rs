//! Validation shared by HTTP signaling and every negotiation writer.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SDP_BYTES: usize = 1024 * 1024;
pub const CANDIDATE_BYTES: usize = 20 * 1024;
pub const PENDING_BYTES: usize = 256 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Options {
    codec: Option<Codec>,
    audio: Option<bool>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Codec {
    H264,
    H265,
    Av1,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Candidate {
    candidate: String,
    sdp_mid: Option<String>,
    // The spelling matches RTCIceCandidateInit and the existing wire contract.
    #[serde(rename = "sdpMlineIndex")]
    sdp_mline_index: Option<u16>,
    username_fragment: Option<String>,
}

pub fn options(value: &Value) -> Result<()> {
    if serde_json::to_vec(value)?.len() > 1024 {
        return Err(Error::Invalid("peer options too large"));
    }
    if !value.is_null() {
        serde_json::from_value::<Options>(value.clone())
            .map_err(|_| Error::Invalid("invalid peer options"))?;
    }
    Ok(())
}

pub fn candidate(value: &Value) -> Result<()> {
    if serde_json::to_vec(value)?.len() > CANDIDATE_BYTES {
        return Err(Error::Invalid("ICE candidate too large"));
    }
    let candidate: Candidate = serde_json::from_value(value.clone())
        .map_err(|_| Error::Invalid("invalid ICE candidate"))?;
    if candidate.candidate.len() > 16 * 1024
        || candidate.sdp_mid.as_ref().is_some_and(|s| s.len() > 256)
        || candidate
            .username_fragment
            .as_ref()
            .is_some_and(|s| s.len() > 256)
    {
        return Err(Error::Invalid("ICE candidate field too large"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_opaque_nested_fields_and_invalid_types() {
        assert!(options(&json!({"extra":"payload"})).is_err());
        assert!(options(&json!({"codec":"vp9"})).is_err());
        assert!(options(&json!({"codec":"h264","audio":true})).is_ok());
        assert!(candidate(&json!({"candidate":"a","extra":"payload"})).is_err());
        assert!(candidate(&json!({"candidate":"a","sdpMlineIndex":-1})).is_err());
        assert!(candidate(&json!({"candidate":"a","sdpMid":"x".repeat(257)})).is_err());
        assert!(candidate(&json!({"candidate":"a","sdpMid":null,"sdpMlineIndex":0})).is_ok());
    }
}
