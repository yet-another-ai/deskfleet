//! Electron owns authorization and signaling. This pipe carries no video pixels.

use std::io::{self, Write};

use deskfleet_native::rtc::{IceCandidate, IceServer};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Command {
    Start {
        title: String,
        #[serde(rename = "iceServers")]
        ice_servers: Vec<Server>,
        #[serde(rename = "relayOnly")]
        relay_only: bool,
        control: bool,
    },
    Answer {
        sdp: String,
    },
    Candidate {
        candidate: Candidate,
    },
    Close,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Server {
    urls: Vec<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    credential: Option<String>,
}

impl From<Server> for IceServer {
    fn from(server: Server) -> Self {
        Self {
            urls: server.urls,
            username: server.username.unwrap_or_default(),
            credential: server.credential.unwrap_or_default(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate {
    pub(crate) candidate: String,
    pub(crate) sdp_mid: Option<String>,
    #[serde(rename = "sdpMlineIndex", alias = "sdpMLineIndex")]
    pub(crate) sdp_mline_index: Option<u16>,
    pub(crate) username_fragment: Option<String>,
}

impl From<Candidate> for IceCandidate {
    fn from(candidate: Candidate) -> Self {
        Self {
            candidate: candidate.candidate,
            sdp_mid: candidate.sdp_mid,
            sdp_mline_index: candidate.sdp_mline_index,
            username_fragment: candidate.username_fragment,
        }
    }
}

impl From<IceCandidate> for Candidate {
    fn from(candidate: IceCandidate) -> Self {
        Self {
            candidate: candidate.candidate,
            sdp_mid: candidate.sdp_mid,
            sdp_mline_index: candidate.sdp_mline_index,
            username_fragment: candidate.username_fragment,
        }
    }
}

pub(crate) fn emit(event: serde_json::Value) -> io::Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, &event)?;
    out.write_all(b"\n")?;
    out.flush()
}
