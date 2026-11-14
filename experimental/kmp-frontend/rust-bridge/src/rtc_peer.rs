//! Pure-Rust WebRTC client PeerConnection + DataChannel + recvonly VideoReceiver
//! compatible across macOS, Linux, Windows, iOS, and Android.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};

use bytes::{Bytes, BytesMut};
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtp_transceiver::rtp_sender::{
    RTCPFeedback, RTCRtpCodec, RTCRtpCodecParameters, RtpCodecKind,
};
use rtc::rtp_transceiver::{RTCRtpTransceiverDirection, RTCRtpTransceiverInit};
use rtc::shared::marshal::Marshal;
use tokio::sync::{Mutex, broadcast, oneshot, watch};
use tokio::task::JoinHandle;
use webrtc::data_channel::{DataChannel, DataChannelEvent, RTCDataChannelState};
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
    RTCConfigurationBuilder, RTCIceCandidateInit, RTCIceGatheringState, RTCIceServer,
    RTCIceTransportPolicy, RTCPeerConnectionIceEvent, RTCPeerConnectionState,
    RTCSessionDescription, Registry, register_default_interceptors,
};
use webrtc::runtime::TokioRuntime;

const MAX_DATA_MESSAGE_SIZE: usize = 65_536;
const MAX_BUFFERED_AMOUNT: usize = 1_048_576;
const EVENT_CAPACITY: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VideoCodec {
    H264,
    H265,
    Av1,
}

#[derive(Clone, Default)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
}

#[derive(Clone, Default)]
pub struct PeerConfig {
    pub ice_servers: Vec<IceServer>,
    pub relay_only: bool,
    pub video: Option<VideoCodec>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IceCandidate {
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_mline_index: Option<u16>,
    pub username_fragment: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PeerState {
    New,
    Connecting,
    Connected,
    Disconnected,
    Failed,
    Closed,
}

#[derive(Clone, Debug)]
pub enum PeerEvent {
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
    Error {
        message: String,
        reason: Option<String>,
    },
}

struct ChannelEntry {
    rtc: Arc<dyn DataChannel>,
    reader: JoinHandle<()>,
}

impl Drop for ChannelEntry {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

type Channels = Arc<Mutex<HashMap<String, ChannelEntry>>>;

struct IncomingVideo(StdMutex<Option<oneshot::Sender<Arc<dyn TrackRemote>>>>);

pub struct ReceivedVideoPacket {
    pub data: Bytes,
}

pub struct VideoReceiver {
    pending_track: Option<oneshot::Receiver<Arc<dyn TrackRemote>>>,
    track: Option<Arc<dyn TrackRemote>>,
    closed: watch::Receiver<bool>,
    ssrc: Option<u32>,
    ended: bool,
}

impl VideoReceiver {
    pub async fn next_packet(&mut self) -> Result<Option<ReceivedVideoPacket>, String> {
        if self.ended || *self.closed.borrow() {
            return Ok(None);
        }
        if let Some(pending) = &mut self.pending_track {
            let track = tokio::select! {
                biased;
                _ = self.closed.changed() => return Ok(None),
                res = pending => res.map_err(|_| "video track was not delivered".to_owned())?,
            };
            self.track = Some(track);
            self.pending_track = None;
        }
        let track = self
            .track
            .as_ref()
            .ok_or_else(|| "video track unavailable".to_owned())?;
        loop {
            let event = tokio::select! {
                biased;
                _ = self.closed.changed() => return Ok(None),
                ev = track.poll() => ev,
            };
            match event {
                Some(TrackRemoteEvent::OnRtpPacket(packet)) => {
                    self.ssrc = Some(packet.header.ssrc);
                    let raw = packet.marshal().map_err(|e| e.to_string())?.freeze();
                    return Ok(Some(ReceivedVideoPacket { data: raw }));
                }
                Some(TrackRemoteEvent::OnError) => {
                    self.ended = true;
                    return Err("remote video track failed".to_owned());
                }
                None | Some(TrackRemoteEvent::OnEnding | TrackRemoteEvent::OnEnded) => {
                    self.ended = true;
                    return Ok(None);
                }
                _ => {}
            }
        }
    }

    pub async fn request_keyframe(&self) -> Result<(), String> {
        if self.ended || *self.closed.borrow() {
            return Err("peer closed".to_owned());
        }
        let track = self.track.as_ref().ok_or("missing video track")?;
        let ssrc = self.ssrc.ok_or("missing video ssrc")?;
        track
            .write_rtcp(vec![Box::new(PictureLossIndication {
                sender_ssrc: 0,
                media_ssrc: ssrc,
            })])
            .await
            .map_err(|e| e.to_string())
    }
}

struct Handler {
    channels: Channels,
    events: broadcast::Sender<PeerEvent>,
    incoming_video: Option<IncomingVideo>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        if let Some(incoming) = &self.incoming_video
            && track.kind().await == RtpCodecKind::Video
            && let Some(tx) = incoming
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
        {
            let _ = tx.send(track);
        }
    }

    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        match event.candidate.to_json() {
            Ok(c) => {
                let _ = self.events.send(PeerEvent::IceCandidate(Some(IceCandidate {
                    candidate: c.candidate,
                    sdp_mid: c.sdp_mid.filter(|m| !m.is_empty()),
                    sdp_mline_index: c.sdp_mline_index,
                    username_fragment: c.username_fragment,
                })));
            }
            Err(e) => {
                let _ = self.events.send(PeerEvent::Error {
                    message: e.to_string(),
                    reason: None,
                });
            }
        }
    }

    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.events.send(PeerEvent::IceCandidate(None));
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let mapped = match state {
            RTCPeerConnectionState::Connecting => PeerState::Connecting,
            RTCPeerConnectionState::Connected => PeerState::Connected,
            RTCPeerConnectionState::Disconnected => PeerState::Disconnected,
            RTCPeerConnectionState::Failed => PeerState::Failed,
            RTCPeerConnectionState::Closed => PeerState::Closed,
            _ => PeerState::New,
        };
        let _ = self.events.send(PeerEvent::StateChanged(mapped));
    }

    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        if let Err(err) = register_channel(Arc::clone(&channel), &self.channels, &self.events).await
        {
            let _ = self.events.send(PeerEvent::Error {
                message: err,
                reason: None,
            });
            let _ = channel.close().await;
        }
    }
}

async fn register_channel(
    channel: Arc<dyn DataChannel>,
    channels: &Channels,
    events: &broadcast::Sender<PeerEvent>,
) -> Result<(), String> {
    let label = channel.label().await.map_err(|e| e.to_string())?;
    let mut map = channels.lock().await;
    if map.contains_key(&label) {
        return Err(format!("duplicate data channel: {label}"));
    }
    let reader_ch = Arc::clone(&channel);
    let weak_map = Arc::downgrade(channels);
    let tx = events.clone();
    let lbl = label.clone();
    let reader = tokio::spawn(async move {
        while let Some(ev) = reader_ch.poll().await {
            match ev {
                DataChannelEvent::OnOpen => {
                    let _ = tx.send(PeerEvent::DataChannelOpen { label: lbl.clone() });
                }
                DataChannelEvent::OnClose => {
                    if let Some(m) = weak_map.upgrade() {
                        m.lock().await.remove(&lbl);
                    }
                    let _ = tx.send(PeerEvent::DataChannelClosed { label: lbl.clone() });
                    return;
                }
                DataChannelEvent::OnMessage(msg) => {
                    if msg.data.len() > MAX_DATA_MESSAGE_SIZE {
                        let _ = tx.send(PeerEvent::Error {
                            message: "data channel message exceeds 65536 bytes".to_owned(),
                            reason: None,
                        });
                    } else {
                        let _ = tx.send(PeerEvent::Data {
                            label: lbl.clone(),
                            data: msg.data.freeze(),
                            is_string: msg.is_string,
                        });
                    }
                }
                DataChannelEvent::OnError => {
                    let _ = tx.send(PeerEvent::Error {
                        message: format!("data channel error: {lbl}"),
                        reason: None,
                    });
                }
                _ => {}
            }
        }
        if let Some(m) = weak_map.upgrade() {
            m.lock().await.remove(&lbl);
        }
    });
    map.insert(
        label,
        ChannelEntry {
            rtc: channel,
            reader,
        },
    );
    Ok(())
}

fn build_media_engine(video: Option<VideoCodec>) -> Result<MediaEngine, String> {
    let mut media = MediaEngine::default();
    if let Some(codec) = video {
        let (mime_type, fmtp, payload_type) = match codec {
            VideoCodec::H264 => (
                "video/H264",
                "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e034",
                102,
            ),
            VideoCodec::H265 => ("video/H265", "profile-id=1;tier-flag=0;level-id=120", 104),
            VideoCodec::Av1 => ("video/AV1", "profile=0;level-idx=8;tier=0", 45),
        };
        media
            .register_codec(
                RTCRtpCodecParameters {
                    rtp_codec: RTCRtpCodec {
                        mime_type: mime_type.to_owned(),
                        clock_rate: 90_000,
                        channels: 0,
                        sdp_fmtp_line: fmtp.to_owned(),
                        rtcp_feedback: vec![
                            RTCPFeedback {
                                typ: "nack".to_owned(),
                                parameter: String::new(),
                            },
                            RTCPFeedback {
                                typ: "nack".to_owned(),
                                parameter: "pli".to_owned(),
                            },
                            RTCPFeedback {
                                typ: "ccm".to_owned(),
                                parameter: "fir".to_owned(),
                            },
                        ],
                    },
                    payload_type,
                },
                RtpCodecKind::Video,
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(media)
}

async fn find_open_channel(
    channels: &Channels,
    label: &str,
    size: usize,
) -> Result<Arc<dyn DataChannel>, String> {
    if size > MAX_DATA_MESSAGE_SIZE {
        return Err("data channel message exceeds 65536 bytes".to_owned());
    }
    let ch = channels
        .lock()
        .await
        .get(label)
        .map(|entry| Arc::clone(&entry.rtc))
        .ok_or_else(|| format!("data channel is not open: {label}"))?;
    let state = ch.ready_state().await.map_err(|e| e.to_string())?;
    if state != RTCDataChannelState::Open {
        return Err(format!("data channel is not open: {label}"));
    }
    Ok(ch)
}

pub struct ClientPeer {
    pc: Arc<dyn PeerConnection>,
    channels: Channels,
    events: broadcast::Sender<PeerEvent>,
    receiver: Mutex<broadcast::Receiver<PeerEvent>>,
    video_receiver: StdMutex<Option<VideoReceiver>>,
    closing: AtomicBool,
    closed: watch::Sender<bool>,
    close_lock: Mutex<()>,
}

impl ClientPeer {
    pub async fn new(config: PeerConfig) -> Result<Self, String> {
        let receiving_video = config.video.is_some();
        let mut media = build_media_engine(config.video)?;
        let interceptors = register_default_interceptors(Registry::new(), &mut media)
            .map_err(|e| e.to_string())?;
        let rtc_config = RTCConfigurationBuilder::default()
            .with_ice_servers(
                config
                    .ice_servers
                    .into_iter()
                    .map(|srv| RTCIceServer {
                        urls: srv.urls,
                        username: srv.username,
                        credential: srv.credential,
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
        let (closed, closed_rx) = watch::channel(false);
        let (incoming_video, video_receiver) = if receiving_video {
            let (tx, rx) = oneshot::channel();
            (
                Some(IncomingVideo(StdMutex::new(Some(tx)))),
                Some(VideoReceiver {
                    pending_track: Some(rx),
                    track: None,
                    closed: closed_rx,
                    ssrc: None,
                    ended: false,
                }),
            )
        } else {
            (None, None)
        };
        let channels: Channels = Arc::new(Mutex::new(HashMap::new()));
        let pc: Arc<dyn PeerConnection> = Arc::new(
            PeerConnectionBuilder::new()
                .with_runtime(Arc::new(TokioRuntime))
                .with_configuration(rtc_config)
                .with_media_engine(media)
                .with_interceptor_registry(interceptors)
                .with_handler(Arc::new(Handler {
                    channels: Arc::clone(&channels),
                    events: events.clone(),
                    incoming_video,
                }))
                .with_data_channel_send_buffer_limit(MAX_BUFFERED_AMOUNT)
                .with_udp_addrs(vec!["0.0.0.0:0", "[::]:0"])
                .build()
                .await
                .map_err(|e| e.to_string())?,
        );
        if receiving_video {
            pc.add_transceiver_from_kind(
                RtpCodecKind::Video,
                Some(RTCRtpTransceiverInit {
                    direction: RTCRtpTransceiverDirection::Recvonly,
                    ..Default::default()
                }),
            )
            .await
            .map_err(|e| e.to_string())?;
        }
        Ok(Self {
            pc,
            channels,
            events,
            receiver: Mutex::new(receiver),
            video_receiver: StdMutex::new(video_receiver),
            closing: AtomicBool::new(false),
            closed,
            close_lock: Mutex::new(()),
        })
    }

    pub fn take_video_receiver(&self) -> Option<VideoReceiver> {
        self.video_receiver
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    fn ensure_open(&self) -> Result<(), String> {
        if self.closing.load(Ordering::Acquire) {
            Err("peer is closed".to_owned())
        } else {
            Ok(())
        }
    }

    pub async fn create_data_channel(&self, label: String) -> Result<(), String> {
        self.ensure_open()?;
        if label.is_empty() || label.len() > 65_535 {
            return Err("invalid data channel label".to_owned());
        }
        let ch = self
            .pc
            .create_data_channel(&label, None)
            .await
            .map_err(|e| e.to_string())?;
        if let Err(err) = register_channel(Arc::clone(&ch), &self.channels, &self.events).await {
            let _ = ch.close().await;
            return Err(err);
        }
        Ok(())
    }

    pub async fn create_offer(&self) -> Result<String, String> {
        self.ensure_open()?;
        let offer = self
            .pc
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;
        let sdp = offer.sdp.clone();
        self.pc
            .set_local_description(offer)
            .await
            .map_err(|e| e.to_string())?;
        Ok(sdp)
    }

    pub async fn answer_offer(&self, sdp: String) -> Result<String, String> {
        self.ensure_open()?;
        let offer = RTCSessionDescription::offer(sdp).map_err(|e| e.to_string())?;
        self.pc
            .set_remote_description(offer)
            .await
            .map_err(|e| e.to_string())?;
        let answer = self
            .pc
            .create_answer(None)
            .await
            .map_err(|e| e.to_string())?;
        let answer_sdp = answer.sdp.clone();
        self.pc
            .set_local_description(answer)
            .await
            .map_err(|e| e.to_string())?;
        Ok(answer_sdp)
    }

    pub async fn accept_answer(&self, sdp: String) -> Result<(), String> {
        self.ensure_open()?;
        let answer = RTCSessionDescription::answer(sdp).map_err(|e| e.to_string())?;
        self.pc
            .set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn add_ice_candidate(&self, candidate: IceCandidate) -> Result<(), String> {
        self.ensure_open()?;
        self.pc
            .add_ice_candidate(RTCIceCandidateInit {
                candidate: candidate.candidate,
                sdp_mid: candidate.sdp_mid,
                sdp_mline_index: candidate.sdp_mline_index,
                username_fragment: candidate.username_fragment,
                ..Default::default()
            })
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn send_data(&self, label: &str, data: Bytes) -> Result<(), String> {
        self.ensure_open()?;
        let ch = find_open_channel(&self.channels, label, data.len()).await?;
        ch.try_send(BytesMut::from(data))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn send_text(&self, label: &str, text: &str) -> Result<(), String> {
        self.ensure_open()?;
        let ch = find_open_channel(&self.channels, label, text.len()).await?;
        ch.try_send_text(text).await.map_err(|e| e.to_string())
    }

    pub async fn next_event(&self) -> Result<Option<PeerEvent>, String> {
        let mut rx = self.receiver.lock().await;
        let mut closed = self.closed.subscribe();
        if *closed.borrow() {
            return match rx.try_recv() {
                Ok(ev) => Ok(Some(ev)),
                Err(broadcast::error::TryRecvError::Lagged(n)) => {
                    Err(format!("peer event consumer missed {n} events"))
                }
                Err(_) => Ok(None),
            };
        }
        tokio::select! {
            biased;
            ev = rx.recv() => match ev {
                Ok(ev) => Ok(Some(ev)),
                Err(broadcast::error::RecvError::Lagged(n)) => Err(format!("peer event consumer missed {n} events")),
                Err(broadcast::error::RecvError::Closed) => Ok(None),
            },
            _ = closed.changed() => Ok(None),
        }
    }

    pub async fn close(&self) -> Result<(), String> {
        let _guard = self.close_lock.lock().await;
        if *self.closed.borrow() {
            return Ok(());
        }
        self.closing.store(true, Ordering::Release);
        let res = self.pc.close().await.map_err(|e| e.to_string());
        self.channels.lock().await.clear();
        self.closed.send_replace(true);
        res
    }
}
