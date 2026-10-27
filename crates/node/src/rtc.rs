//! Async Node-API adapter; the daemon owns each peer and its capture lifetime.

use std::sync::Arc;

use deskfleet_native::{input::InputWorker, media::DesktopStream, rtc};
use napi::bindgen_prelude::{Buffer, BufferSlice, PromiseRaw};
use napi::{Env, Error, Result};
use napi_derive::napi;
use tokio::sync::Mutex;

use crate::media::DesktopConfig;

pub(crate) fn native_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(error.to_string())
}

#[napi(object)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

#[napi(string_enum = "lowercase")]
pub enum VideoCodec {
    H264,
    H265,
    Av1,
}

#[napi(object)]
pub struct PeerConfig {
    pub ice_servers: Option<Vec<IceServer>>,
    pub relay_only: Option<bool>,
    pub video: Option<VideoCodec>,
    pub audio: Option<bool>,
}

#[napi(object)]
pub struct IceCandidate {
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_mline_index: Option<u16>,
    pub username_fragment: Option<String>,
}

impl From<IceCandidate> for rtc::IceCandidate {
    fn from(candidate: IceCandidate) -> Self {
        Self {
            candidate: candidate.candidate,
            sdp_mid: candidate.sdp_mid,
            sdp_mline_index: candidate.sdp_mline_index,
            username_fragment: candidate.username_fragment,
        }
    }
}

impl From<rtc::IceCandidate> for IceCandidate {
    fn from(candidate: rtc::IceCandidate) -> Self {
        Self {
            candidate: candidate.candidate,
            sdp_mid: candidate.sdp_mid,
            sdp_mline_index: candidate.sdp_mline_index,
            username_fragment: candidate.username_fragment,
        }
    }
}

/// Events use `kind` as their discriminator; data messages preserve binary bytes.
#[napi(object)]
pub struct PeerEvent {
    pub kind: String,
    pub candidate: Option<IceCandidate>,
    pub state: Option<String>,
    pub label: Option<String>,
    pub data: Option<Buffer>,
    pub is_string: Option<bool>,
    pub error: Option<String>,
    /// `"encoder"` when the viewer may negotiate the next codec. Absent for every other failure.
    pub reason: Option<String>,
}

/// The capture worker's latest media failure, if `startDesktop` observed it first.
#[napi(object)]
pub struct MediaFailure {
    pub message: String,
    pub reason: Option<String>,
}

impl From<rtc::PeerEvent> for PeerEvent {
    fn from(event: rtc::PeerEvent) -> Self {
        let mut result = Self {
            kind: String::new(),
            candidate: None,
            state: None,
            label: None,
            data: None,
            is_string: None,
            error: None,
            reason: None,
        };
        match event {
            rtc::PeerEvent::IceCandidate(candidate) => {
                result.kind = if candidate.is_some() {
                    "iceCandidate"
                } else {
                    "iceGatheringComplete"
                }
                .to_owned();
                result.candidate = candidate.map(Into::into);
            }
            rtc::PeerEvent::StateChanged(state) => {
                result.kind = "stateChanged".to_owned();
                result.state = Some(
                    match state {
                        rtc::PeerState::New => "new",
                        rtc::PeerState::Connecting => "connecting",
                        rtc::PeerState::Connected => "connected",
                        rtc::PeerState::Disconnected => "disconnected",
                        rtc::PeerState::Failed => "failed",
                        rtc::PeerState::Closed => "closed",
                    }
                    .to_owned(),
                );
            }
            rtc::PeerEvent::DataChannelOpen { label } => {
                result.kind = "dataChannelOpen".to_owned();
                result.label = Some(label);
            }
            rtc::PeerEvent::DataChannelClosed { label } => {
                result.kind = "dataChannelClosed".to_owned();
                result.label = Some(label);
            }
            rtc::PeerEvent::Data {
                label,
                data,
                is_string,
            } => {
                result.kind = "data".to_owned();
                result.label = Some(label);
                // Transfer uniquely owned storage; Bytes copies if another owner still exists.
                result.data = Some(Vec::<u8>::from(data).into());
                result.is_string = Some(is_string);
            }
            rtc::PeerEvent::KeyframeRequested => result.kind = "keyframeRequested".to_owned(),
            rtc::PeerEvent::Error { message, reason } => {
                result.kind = "error".to_owned();
                result.error = Some(message);
                result.reason = reason;
            }
        }
        result
    }
}

#[napi]
pub struct NativePeer {
    peer: Arc<rtc::Peer>,
    desktop: Mutex<Option<DesktopStream>>,
    input: Mutex<Option<InputWorker>>,
}

/// Create a transport without accessing a display or initializing an encoder.
#[napi]
pub async fn create_peer(config: PeerConfig) -> Result<NativePeer> {
    let config = rtc::PeerConfig {
        ice_servers: config
            .ice_servers
            .unwrap_or_default()
            .into_iter()
            .map(|server| rtc::IceServer {
                urls: server.urls,
                username: server.username.unwrap_or_default(),
                credential: server.credential.unwrap_or_default(),
            })
            .collect(),
        relay_only: config.relay_only.unwrap_or(false),
        video: config.video.map(|codec| match codec {
            VideoCodec::H264 => rtc::VideoCodec::H264,
            VideoCodec::H265 => rtc::VideoCodec::H265,
            VideoCodec::Av1 => rtc::VideoCodec::Av1,
        }),
        audio: config.audio.unwrap_or(false),
    };
    Ok(NativePeer {
        peer: Arc::new(rtc::Peer::new(config).await.map_err(native_error)?),
        desktop: Mutex::new(None),
        input: Mutex::new(None),
    })
}

#[napi]
impl NativePeer {
    #[napi]
    pub async fn create_offer(&self) -> Result<String> {
        self.peer.create_offer().await.map_err(native_error)
    }

    #[napi]
    pub async fn answer_offer(&self, sdp: String) -> Result<String> {
        self.peer.answer_offer(sdp).await.map_err(native_error)
    }

    #[napi]
    pub async fn accept_answer(&self, sdp: String) -> Result<()> {
        self.peer.accept_answer(sdp).await.map_err(native_error)
    }

    #[napi]
    pub async fn add_ice_candidate(&self, candidate: IceCandidate) -> Result<()> {
        self.peer
            .add_ice_candidate(candidate.into())
            .await
            .map_err(native_error)
    }

    #[napi]
    pub async fn create_data_channel(&self, label: String) -> Result<()> {
        self.peer
            .create_data_channel(label)
            .await
            .map_err(native_error)
    }

    /// Enable loopback TCP forwarding only after checking the peer's grant.
    #[napi]
    pub async fn enable_port_forwarding(&self, expires_at_ms: f64) -> Result<()> {
        if !expires_at_ms.is_finite()
            || expires_at_ms.fract() != 0.0
            || !(1.0..=9_007_199_254_740_991.0).contains(&expires_at_ms)
        {
            return Err(native_error("invalid port forwarding authorization expiry"));
        }
        self.peer
            .enable_port_forwarding(expires_at_ms as u64)
            .await
            .map_err(native_error)
    }

    /// Bind a loopback TCP listener and prepare its channel before creating an offer.
    #[napi]
    pub async fn listen_port_forward(
        &self,
        local_port: f64,
        target_host: String,
        target_port: f64,
    ) -> Result<u16> {
        if !local_port.is_finite()
            || local_port.fract() != 0.0
            || !(0.0..=65535.0).contains(&local_port)
            || !target_port.is_finite()
            || target_port.fract() != 0.0
            || !(1.0..=65535.0).contains(&target_port)
        {
            return Err(native_error("invalid TCP port"));
        }
        self.peer
            .listen_port_forward(local_port as u16, &target_host, target_port as u16)
            .await
            .map_err(native_error)
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn send_data<'env>(
        &self,
        env: &'env Env,
        label: String,
        data: BufferSlice<'env>,
    ) -> Result<PromiseRaw<'env, ()>> {
        // Snapshot on the JS thread before returning: callers may immediately reuse
        // their mutable Buffer. Only owned storage crosses into the async transport.
        let data = data.as_ref().to_vec();
        let peer = Arc::clone(&self.peer);
        env.spawn_future(async move {
            peer.send_data(&label, data.into())
                .await
                .map_err(native_error)
        })
    }

    #[napi]
    pub async fn send_text(&self, label: String, text: String) -> Result<()> {
        self.peer
            .send_text(&label, &text)
            .await
            .map_err(native_error)
    }

    /// Consume events from one daemon loop. Resolves with null after close.
    #[napi]
    pub async fn next_event(&self) -> Result<Option<PeerEvent>> {
        self.peer
            .next_event()
            .await
            .map(|event| event.map(Into::into))
            .map_err(native_error)
    }

    /// Take the capture worker's latest media failure, if one was reported.
    #[napi]
    pub fn take_media_failure(&self) -> Option<MediaFailure> {
        self.peer
            .take_media_failure()
            .map(|(message, reason)| MediaFailure { message, reason })
    }

    /// Capture and encode entirely in Rust; call only after authorizing desktop access.
    #[napi]
    pub async fn start_desktop(&self, config: DesktopConfig) -> Result<()> {
        let mut desktop = self.desktop.lock().await;
        if self.peer.is_closed() {
            return Err(native_error("peer is closed"));
        }
        if desktop.is_some() {
            return Err(native_error("desktop stream is already started"));
        }
        let input = if config.control.unwrap_or(false) {
            Some(
                InputWorker::start(config.display_id)
                    .await
                    .map_err(native_error)?,
            )
        } else {
            None
        };
        let stream = match DesktopStream::start(Arc::clone(&self.peer), config.into()).await {
            Ok(stream) => stream,
            Err(error) => {
                if let Some(input) = input {
                    input.stop().await.map_err(native_error)?;
                }
                return Err(native_error(error));
            }
        };
        *desktop = Some(stream);
        *self.input.lock().await = input;
        Ok(())
    }

    /// Apply a desktop DataChannel message after the daemon checks its control grant.
    #[napi]
    pub async fn send_desktop_input(&self, message: String) -> Result<()> {
        if message.len() > 4096 {
            return Err(native_error("desktop input message is too large"));
        }
        let event = serde_json::from_str(&message).map_err(native_error)?;
        let input = self.input.lock().await;
        input
            .as_ref()
            .ok_or_else(|| native_error("desktop control is not enabled"))?
            .handle(event)
            .await
            .map_err(native_error)
    }

    #[napi]
    pub async fn stop_desktop(&self) -> Result<()> {
        let mut desktop = self.desktop.lock().await;
        let input = match self.input.lock().await.take() {
            Some(input) => input.stop().await.map_err(native_error),
            None => Ok(()),
        };
        if let Some(stream) = desktop.take() {
            stream.stop().await.map_err(native_error)?;
        }
        input
    }

    /// Stop capture before closing the transport, including after media failure.
    #[napi]
    pub async fn close(&self) -> Result<()> {
        let mut desktop = self.desktop.lock().await;
        let input = match self.input.lock().await.take() {
            Some(input) => input.stop().await.map_err(native_error),
            None => Ok(()),
        };
        let media = match desktop.take() {
            Some(stream) => stream.stop().await.map_err(native_error),
            None => Ok(()),
        };
        let transport = self.peer.close().await.map_err(native_error);
        input.and(media).and(transport)
    }
}
