use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::broadcast;
use webrtc::data_channel::DataChannel;
use webrtc::peer_connection::{
    PeerConnectionEventHandler, RTCIceGatheringState, RTCPeerConnectionIceEvent,
    RTCPeerConnectionState,
};

use super::{IceCandidate, PeerEvent, PeerState, channels};

pub(super) struct Handler {
    pub(super) channels: channels::Channels,
    pub(super) events: broadcast::Sender<PeerEvent>,
    pub(super) keyframe: Arc<AtomicBool>,
    pub(super) has_video: bool,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        let event = match event.candidate.to_json() {
            Ok(candidate) => PeerEvent::IceCandidate(Some(IceCandidate {
                candidate: candidate.candidate,
                sdp_mid: candidate.sdp_mid.filter(|mid| !mid.is_empty()),
                sdp_mline_index: candidate.sdp_mline_index,
                username_fragment: candidate.username_fragment,
            })),
            Err(error) => PeerEvent::Error(error.to_string()),
        };
        let _ = self.events.send(event);
    }

    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.events.send(PeerEvent::IceCandidate(None));
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let state = match state {
            RTCPeerConnectionState::Connecting => PeerState::Connecting,
            RTCPeerConnectionState::Connected => PeerState::Connected,
            RTCPeerConnectionState::Disconnected => PeerState::Disconnected,
            RTCPeerConnectionState::Failed => PeerState::Failed,
            RTCPeerConnectionState::Closed => PeerState::Closed,
            _ => PeerState::New,
        };
        tracing::debug!(?state, "peer connection state changed");
        let _ = self.events.send(PeerEvent::StateChanged(state));
        if self.has_video && state == PeerState::Connected {
            self.keyframe.store(true, Ordering::Relaxed);
            let _ = self.events.send(PeerEvent::KeyframeRequested);
        }
    }

    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        if let Err(error) =
            channels::register(Arc::clone(&channel), &self.channels, &self.events).await
        {
            let _ = self.events.send(PeerEvent::Error(error.to_string()));
            if let Err(error) = channel.close().await {
                let _ = self.events.send(PeerEvent::Error(error.to_string()));
            }
        }
    }
}
