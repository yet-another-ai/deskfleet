//! Native WebRTC transport adapted from desk-fleet's media-plane streamer.
//!
//! The daemon supplies authenticated signaling and owns each peer. No capture
//! backend or display is initialized by this module. Encoded frames stay in Rust
//! when written to the media tracks.

mod channels;
mod codecs;
mod events;
mod feedback;
mod h265_payloader;
mod sample_track;
mod types;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bytes::Bytes;
pub use channels::MAX_DATA_MESSAGE_SIZE;
use rtc::interceptor::Slot;
use rtc::media::Sample;
use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
use sample_track::SampleTrack;
use tokio::sync::{Mutex, broadcast, watch};
use tokio::task::JoinHandle;
pub use types::{
    IceCandidate, IceServer, PeerConfig, PeerError, PeerEvent, PeerState, Result, VideoCodec,
};
use webrtc::media_stream::track_local::{TrackLocal, TrackLocalEvent};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, RTCConfigurationBuilder, RTCIceCandidateInit,
    RTCIceServer, RTCIceTransportPolicy, RTCSessionDescription, Registry,
    register_default_interceptors,
};

const EVENT_CAPACITY: usize = 256;

/// One independently owned peer connection. Call [`close`](Self::close) when
/// its session ends; dropping it schedules best-effort asynchronous cleanup.
pub struct Peer {
    pc: Arc<dyn PeerConnection>,
    video: Option<Arc<SampleTrack>>,
    audio: Option<Arc<SampleTrack>>,
    video_codec: Option<VideoCodec>,
    channels: channels::Channels,
    events: broadcast::Sender<PeerEvent>,
    receiver: Mutex<broadcast::Receiver<PeerEvent>>,
    keyframe_requested: Arc<AtomicBool>,
    media_failure: StdMutex<Option<(String, Option<String>)>>,
    closing: AtomicBool,
    closed: watch::Sender<bool>,
    close_lock: Mutex<()>,
    readers: Mutex<Vec<JoinHandle<()>>>,
    runtime: tokio::runtime::Handle,
}

impl Peer {
    /// Create a peer with optional sending tracks and caller-provided ICE
    /// servers. The default configuration supports DataChannels only.
    pub async fn new(config: PeerConfig) -> Result<Self> {
        let media = codecs::media_engine(&config)?;
        Self::with_media_engine(config, media).await
    }

    async fn with_media_engine(
        config: PeerConfig,
        mut media: webrtc::peer_connection::MediaEngine,
    ) -> Result<Self> {
        let interceptors = register_default_interceptors(Registry::new(), &mut media)?
            .with(Slot::from(14_000), feedback::KeyframeFeedback::default());
        let rtc_config = RTCConfigurationBuilder::default()
            .with_ice_servers(
                config
                    .ice_servers
                    .into_iter()
                    .map(|server| RTCIceServer {
                        urls: server.urls,
                        username: server.username,
                        credential: server.credential,
                    })
                    .collect(),
            )
            .with_ice_transport_policy(if config.relay_only {
                RTCIceTransportPolicy::Relay
            } else {
                RTCIceTransportPolicy::All
            })
            .build();
        let (events, receiver) = broadcast::channel(EVENT_CAPACITY);
        let (closed, _) = watch::channel(false);
        let keyframe_requested = Arc::new(AtomicBool::new(config.video.is_some()));
        let channels = Arc::new(Mutex::new(HashMap::new()));
        let pc = Arc::new(
            PeerConnectionBuilder::new()
                .with_configuration(rtc_config)
                .with_media_engine(media)
                .with_interceptor_registry(interceptors)
                .with_handler(Arc::new(events::Handler {
                    channels: Arc::clone(&channels),
                    events: events.clone(),
                    keyframe: Arc::clone(&keyframe_requested),
                    has_video: config.video.is_some(),
                }))
                .with_data_channel_send_buffer_limit(channels::MAX_BUFFERED_AMOUNT)
                .with_udp_addrs(vec!["0.0.0.0:0", "[::]:0"])
                .build()
                .await?,
        );
        let mut peer = Self {
            pc,
            video: None,
            audio: None,
            video_codec: config.video,
            channels,
            events,
            receiver: Mutex::new(receiver),
            keyframe_requested,
            media_failure: StdMutex::new(None),
            closing: AtomicBool::new(false),
            closed,
            close_lock: Mutex::new(()),
            readers: Mutex::new(Vec::new()),
            runtime: tokio::runtime::Handle::current(),
        };
        if let Some(codec) = config.video {
            let track = Arc::new(
                SampleTrack::new(
                    peer.pc.as_ref(),
                    codecs::video_capability(codec),
                    "video",
                    RtpCodecKind::Video,
                )
                .await?,
            );
            peer.readers.lock().await.push(rtcp_reader(
                track.track.clone(),
                peer.events.clone(),
                Arc::clone(&peer.keyframe_requested),
            ));
            peer.video = Some(track);
        }
        if config.audio {
            peer.audio = Some(Arc::new(
                SampleTrack::new(
                    peer.pc.as_ref(),
                    codecs::audio_capability(),
                    "audio",
                    RtpCodecKind::Audio,
                )
                .await?,
            ));
        }
        Ok(peer)
    }

    fn ensure_open(&self) -> Result<()> {
        if self.closing.load(Ordering::Acquire) {
            Err(PeerError::Closed)
        } else {
            Ok(())
        }
    }

    pub fn video_codec(&self) -> Option<VideoCodec> {
        self.video_codec
    }

    pub fn has_audio(&self) -> bool {
        self.audio.is_some()
    }

    /// True as soon as explicit shutdown begins.
    pub fn is_closed(&self) -> bool {
        self.closing.load(Ordering::Acquire)
    }

    /// Consume a coalesced encoder keyframe request without taking signaling or
    /// DataChannel events away from the daemon's event consumer.
    pub fn take_keyframe_request(&self) -> bool {
        self.keyframe_requested.swap(false, Ordering::Relaxed)
    }

    /// Record a capture/encoder failure and wake the daemon event loop.
    ///
    /// `reason` is `"encoder"` when another negotiated codec may succeed.
    /// The latest failure stays available to the `startDesktop` caller because
    /// that RPC can return before the event loop forwards the same failure.
    pub(crate) fn report_media_error(&self, message: String, reason: Option<&str>) {
        let reason = reason.map(str::to_owned);
        *self
            .media_failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
            Some((message.clone(), reason.clone()));
        let _ = self.events.send(PeerEvent::Error { message, reason });
    }

    /// Take the media failure reported by the capture worker, if any.
    pub fn take_media_failure(&self) -> Option<(String, Option<String>)> {
        self.media_failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }

    /// Create an SDP offer and begin trickling ICE candidates through events.
    pub async fn create_offer(&self) -> Result<String> {
        self.ensure_open()?;
        let offer = self.pc.create_offer(None).await?;
        let sdp = offer.sdp.clone();
        self.pc.set_local_description(offer).await?;
        Ok(sdp)
    }

    /// Accept a remote offer and produce an answer. Add remote ICE candidates
    /// after this method resolves, then continue consuming local ICE events.
    pub async fn answer_offer(&self, sdp: String) -> Result<String> {
        self.ensure_open()?;
        let offer = RTCSessionDescription::offer(sdp)?;
        codecs::validate_remote_video(&offer, self.video_codec)?;
        self.pc.set_remote_description(offer).await?;
        let answer = self.pc.create_answer(None).await?;
        let sdp = answer.sdp.clone();
        self.pc.set_local_description(answer).await?;
        Ok(sdp)
    }

    pub async fn accept_answer(&self, sdp: String) -> Result<()> {
        self.ensure_open()?;
        let answer = RTCSessionDescription::answer(sdp)?;
        codecs::validate_remote_video(&answer, self.video_codec)?;
        self.pc.set_remote_description(answer).await?;
        Ok(())
    }

    pub async fn add_ice_candidate(&self, candidate: IceCandidate) -> Result<()> {
        self.ensure_open()?;
        self.pc
            .add_ice_candidate(RTCIceCandidateInit {
                candidate: candidate.candidate,
                sdp_mid: candidate.sdp_mid,
                sdp_mline_index: candidate.sdp_mline_index,
                username_fragment: candidate.username_fragment,
                ..Default::default()
            })
            .await?;
        Ok(())
    }

    /// Create an ordered, reliable DataChannel before making the initial offer.
    pub async fn create_data_channel(&self, label: String) -> Result<()> {
        self.ensure_open()?;
        if label.is_empty() || label.len() > 65_535 {
            return Err(PeerError::InvalidDataChannelLabel);
        }
        let channel = self.pc.create_data_channel(&label, None).await?;
        if let Err(error) =
            channels::register(Arc::clone(&channel), &self.channels, &self.events).await
        {
            channel.close().await?;
            return Err(error);
        }
        Ok(())
    }

    /// Reject messages above 64 KiB or writes that exceed the 1 MiB send budget.
    /// A full send buffer is reported as [`PeerError::Backpressure`].
    pub async fn send_data(&self, label: &str, data: Bytes) -> Result<()> {
        self.ensure_open()?;
        channels::send_data(&self.channels, label, &data).await
    }

    pub async fn send_text(&self, label: &str, text: &str) -> Result<()> {
        self.ensure_open()?;
        channels::send_text(&self.channels, label, text).await
    }

    /// Send one complete encoded access unit using the configured video codec.
    /// H.264/H.265 input is Annex B; AV1 input is an encoded OBU stream.
    pub async fn write_video(&self, data: Bytes, duration: Duration) -> Result<()> {
        self.write_sample(self.video.as_deref(), "video", data, duration)
            .await
    }

    /// Send one Opus packet, with the duration of the encoded PCM frames.
    pub async fn write_audio(&self, data: Bytes, duration: Duration) -> Result<()> {
        self.write_sample(self.audio.as_deref(), "audio", data, duration)
            .await
    }

    async fn write_sample(
        &self,
        track: Option<&SampleTrack>,
        kind: &'static str,
        data: Bytes,
        duration: Duration,
    ) -> Result<()> {
        self.ensure_open()?;
        let track = track.ok_or(PeerError::MissingTrack(kind))?;
        if data.is_empty() || duration.is_zero() {
            return Err(PeerError::InvalidSample);
        }
        track
            .write_sample(&Sample {
                data,
                duration,
                ..Sample::new(std::time::Instant::now())
            })
            .await?;
        Ok(())
    }

    /// Receive one event. The queue holds 256 events; an overrun is reported as
    /// [`PeerError::EventsLagged`] so signaling cannot silently lose candidates.
    /// Returns `None` once close completes and queued events have been drained.
    pub async fn next_event(&self) -> Result<Option<PeerEvent>> {
        let mut receiver = self.receiver.lock().await;
        let mut closed = self.closed.subscribe();
        if *closed.borrow() {
            return match receiver.try_recv() {
                Ok(event) => Ok(Some(event)),
                Err(broadcast::error::TryRecvError::Lagged(count)) => {
                    Err(PeerError::EventsLagged(count))
                }
                Err(_) => Ok(None),
            };
        }
        tokio::select! {
            biased;
            event = receiver.recv() => match event {
                Ok(event) => Ok(Some(event)),
                Err(broadcast::error::RecvError::Lagged(count)) => Err(PeerError::EventsLagged(count)),
                Err(broadcast::error::RecvError::Closed) => Ok(None),
            },
            _ = closed.changed() => Ok(None),
        }
    }

    /// Close transports and wait for media feedback readers. Concurrent and
    /// repeated closes are safe; no event consumer is needed for shutdown.
    pub async fn close(&self) -> Result<()> {
        let _close = self.close_lock.lock().await;
        if *self.closed.borrow() {
            return Ok(());
        }
        self.closing.store(true, Ordering::Release);
        let result = self.pc.close().await;
        let readers = std::mem::take(&mut *self.readers.lock().await);
        for task in readers {
            task.abort();
            let _ = task.await;
        }
        self.channels.lock().await.clear();
        self.closed.send_replace(true);
        result.map_err(PeerError::from)
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        for task in self.readers.get_mut().drain(..) {
            task.abort();
        }
        if !*self.closed.borrow() {
            let pc = Arc::clone(&self.pc);
            self.runtime.spawn(async move {
                if let Err(error) = pc.close().await {
                    tracing::warn!(%error, "closing dropped WebRTC peer failed");
                }
            });
        }
    }
}

fn rtcp_reader(
    track: Arc<dyn TrackLocal>,
    events: broadcast::Sender<PeerEvent>,
    keyframe: Arc<AtomicBool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(event) = track.poll().await {
            if let TrackLocalEvent::OnRtcpPacket(packets) = event
                && packets
                    .iter()
                    .any(|packet| feedback::is_keyframe_request(packet.as_ref()))
            {
                keyframe.store(true, Ordering::Relaxed);
                let _ = events.send(PeerEvent::KeyframeRequested);
            }
        }
    })
}
