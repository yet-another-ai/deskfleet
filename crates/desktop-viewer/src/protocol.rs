//! Electron owns authorization and signaling. This pipe carries no video pixels.

use std::io::{self, Write};

use deskfleet_native::rtc::{IceCandidate, IceServer, VideoCodec};
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
        codec: Codec,
        width: u32,
        height: u32,
    },
    Answer {
        sdp: String,
    },
    Candidate {
        candidate: Candidate,
    },
    /// Release the current peer while keeping the native window open.
    Stop,
    SetControl {
        control: bool,
    },
    Ui {
        state: UiState,
    },
    Close,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Status {
    #[default]
    Connecting,
    Starting,
    Connected,
    Disconnected,
    Error,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Display {
    pub(crate) id: u32,
    pub(crate) name: Option<String>,
    pub(crate) display_number: Option<u32>,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UiState {
    pub(crate) status: Status,
    pub(crate) title: String,
    pub(crate) codec: Option<Codec>,
    pub(crate) displays: Vec<Display>,
    pub(crate) display_id: u32,
    pub(crate) control: bool,
    pub(crate) input_ready: bool,
    pub(crate) secure_attention: bool,
    pub(crate) error: Option<String>,
    pub(crate) settings_error: Option<String>,
    pub(crate) locale: Option<String>,
    pub(crate) theme: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Codec {
    H264,
    H265,
    Av1,
}
impl From<Codec> for VideoCodec {
    fn from(value: Codec) -> Self {
        match value {
            Codec::H264 => Self::H264,
            Codec::H265 => Self::H265,
            Codec::Av1 => Self::Av1,
        }
    }
}
impl From<VideoCodec> for Codec {
    fn from(value: VideoCodec) -> Self {
        match value {
            VideoCodec::H264 => Self::H264,
            VideoCodec::H265 => Self::H265,
            VideoCodec::Av1 => Self::Av1,
        }
    }
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

use std::sync::{Mutex, OnceLock};

pub(crate) type Emitter = Box<dyn Fn(String) -> io::Result<()> + Send + Sync>;

static EMITTER: OnceLock<Mutex<Option<Emitter>>> = OnceLock::new();

#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) fn set_emitter(emitter: Option<Emitter>) {
    if let Ok(mut guard) = EMITTER.get_or_init(|| Mutex::new(None)).lock() {
        *guard = emitter;
    }
}

pub(crate) fn emit(event: serde_json::Value) -> io::Result<()> {
    if let Some(mutex) = EMITTER.get()
        && let Ok(guard) = mutex.lock()
        && let Some(emitter) = guard.as_ref()
    {
        let payload = serde_json::to_string(&event)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        return emitter(payload);
    }
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, &event)?;
    out.write_all(b"\n")?;
    out.flush()
}
