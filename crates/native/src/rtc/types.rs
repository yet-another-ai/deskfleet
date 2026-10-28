use bytes::Bytes;

/// ICE server credentials supplied by the signaling service.
#[derive(Clone, Default)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
}

/// Video profiles produced by DeskFleet's encoders.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VideoCodec {
    H264,
    H265,
    Av1,
}

/// Transport configuration. Media tracks are created only when requested.
#[derive(Clone, Default)]
pub struct PeerConfig {
    pub ice_servers: Vec<IceServer>,
    /// Restrict ICE to TURN relay candidates.
    pub relay_only: bool,
    pub video: Option<VideoCodec>,
    /// Add a stereo, 48 kHz Opus track.
    pub audio: bool,
}

/// A trickled ICE candidate. An empty candidate marks the end of candidates.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IceCandidate {
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_mline_index: Option<u16>,
    pub username_fragment: Option<String>,
}

/// Aggregate ICE/DTLS connection state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PeerState {
    New,
    Connecting,
    Connected,
    Disconnected,
    Failed,
    Closed,
}

/// Events available to the daemon through a bounded queue.
#[derive(Clone, Debug)]
pub enum PeerEvent {
    /// `None` means gathering is complete.
    IceCandidate(Option<IceCandidate>),
    StateChanged(PeerState),
    DataChannelOpen {
        label: String,
    },
    DataChannelClosed {
        label: String,
    },
    Data {
        label: String,
        data: Bytes,
        is_string: bool,
    },
    KeyframeRequested,
    /// `reason` is `Some("encoder")` when the viewer may open a new peer for the next codec.
    /// Older consumers ignore `reason` and treat the failure as terminal.
    Error {
        message: String,
        reason: Option<String>,
    },
}

impl PeerEvent {
    pub(crate) fn error(message: impl Into<String>) -> Self {
        Self::Error {
            message: message.into(),
            reason: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PeerError {
    #[error(transparent)]
    WebRtc(#[from] webrtc::error::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("port forwarding: {0}")]
    PortForwarding(&'static str),
    #[error("peer is closed")]
    Closed,
    #[error("data channel is not open: {0}")]
    DataChannelNotOpen(String),
    #[error("data channel already exists: {0}")]
    DuplicateDataChannel(String),
    #[error("data channel label must contain 1 to 65535 bytes")]
    InvalidDataChannelLabel,
    #[error("data channel message exceeds 65536 bytes")]
    MessageTooLarge,
    #[error("data channel send buffer is full")]
    Backpressure,
    #[error("peer event consumer missed {0} events")]
    EventsLagged(u64),
    #[error("{0} track is not configured")]
    MissingTrack(&'static str),
    #[error("media sample data and duration must be nonzero")]
    InvalidSample,
    #[error("remote SDP does not accept the configured video codec profile")]
    IncompatibleVideoCodec,
}

pub type Result<T> = std::result::Result<T, PeerError>;
