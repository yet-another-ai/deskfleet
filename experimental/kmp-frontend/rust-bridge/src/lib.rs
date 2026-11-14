//! Cross-platform WebRTC + Video + NAT + LocalNetwork native bridge for DeskFleet KMP.

pub mod ffi;
pub mod jni_api;
pub mod nat_probe;
pub mod rtc_peer;
pub mod video;

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use base64::Engine as _;
use bytes::Bytes;
use rtc_peer::{
    ClientPeer, IceCandidate, IceServer, PeerConfig, PeerEvent, PeerState, VideoCodec,
};
use serde::{Deserialize, Serialize};
use video::{FrameSlot, spawn_video_worker};

static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .thread_name("deskfleet-kmp-rtc")
        .build()
        .expect("tokio multi-thread runtime initialization")
});

static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);
static PEERS: LazyLock<Mutex<HashMap<u64, Arc<ManagedPeer>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

thread_local! {
    static LAST_ERROR: RefCell<Option<String>> = const { RefCell::new(None) };
}

pub(crate) fn set_error(msg: impl Into<String>) {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = Some(msg.into()));
}

pub(crate) fn clear_error() {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = None);
}

pub fn take_last_error() -> Option<String> {
    LAST_ERROR.with(|slot| slot.borrow_mut().take())
}

pub struct ManagedPeer {
    peer: ClientPeer,
    local_mids: Mutex<Vec<String>>,
    frames: Arc<FrameSlot>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IceServerDto {
    #[serde(default)]
    urls: Vec<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    credential: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeerCreateDto {
    #[serde(default)]
    ice_servers: Vec<IceServerDto>,
    #[serde(default)]
    relay_only: bool,
    #[serde(default)]
    video_codec: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct IceCandidateDto {
    candidate: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sdp_mid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sdp_m_line_index: Option<u16>,
    #[serde(default, skip_serializing)]
    sdp_mline_index: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username_fragment: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum BridgeEventDto {
    IceCandidate {
        candidate: Option<IceCandidateDto>,
    },
    StateChanged {
        state: &'static str,
    },
    DataChannelOpen {
        label: String,
    },
    DataChannelClosed {
        label: String,
    },
    Data {
        label: String,
        #[serde(rename = "dataBase64")]
        data_base64: String,
        #[serde(rename = "isString")]
        is_string: bool,
    },
    Error {
        message: String,
        reason: Option<String>,
    },
    Closed,
}

fn parse_mids_from_sdp(sdp: &str) -> Vec<String> {
    let mut mids = Vec::new();
    let mut in_media = false;
    let mut current_mid: Option<String> = None;
    for raw_line in sdp.lines() {
        let line = raw_line.trim();
        if line.starts_with("m=") {
            if in_media {
                mids.push(current_mid.take().unwrap_or_default());
            }
            in_media = true;
        } else if in_media && let Some(mid) = line.strip_prefix("a=mid:") {
            current_mid = Some(mid.to_owned());
        }
    }
    if in_media {
        mids.push(current_mid.unwrap_or_default());
    }
    mids
}

fn get_peer(handle: u64) -> Result<Arc<ManagedPeer>, String> {
    let guard = PEERS
        .lock()
        .map_err(|_| "peer registry mutex poisoned".to_owned())?;
    guard
        .get(&handle)
        .cloned()
        .ok_or_else(|| format!("unknown peer handle {handle}"))
}

pub fn create_peer(config_json: &str) -> Result<u64, String> {
    clear_error();
    let dto: PeerCreateDto =
        serde_json::from_str(config_json).map_err(|e| format!("invalid peer config: {e}"))?;
    let video = match dto.video_codec.as_deref() {
        None | Some("") => None,
        Some("h264" | "H264") => Some(VideoCodec::H264),
        Some("h265" | "H265" | "hevc") => Some(VideoCodec::H265),
        Some("av1" | "AV1") => Some(VideoCodec::Av1),
        Some(other) => return Err(format!("unsupported video codec: {other}")),
    };
    let config = PeerConfig {
        ice_servers: dto
            .ice_servers
            .into_iter()
            .map(|srv| IceServer {
                urls: srv.urls,
                username: srv.username.unwrap_or_default(),
                credential: srv.credential.unwrap_or_default(),
            })
            .collect(),
        relay_only: dto.relay_only,
        video,
    };
    let frames = Arc::new(FrameSlot::default());
    let rt_handle = RUNTIME.handle().clone();
    let frames_for_worker = Arc::clone(&frames);
    let peer = RUNTIME.block_on(async move {
        let peer = ClientPeer::new(config).await?;
        if let Some(receiver) = peer.take_video_receiver() {
            spawn_video_worker(receiver, frames_for_worker, rt_handle);
        }
        Ok::<ClientPeer, String>(peer)
    })?;
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    let managed = Arc::new(ManagedPeer {
        peer,
        local_mids: Mutex::new(Vec::new()),
        frames,
    });
    PEERS
        .lock()
        .map_err(|_| "peer registry poisoned".to_owned())?
        .insert(handle, managed);
    Ok(handle)
}

pub fn create_data_channel(handle: u64, label: &str) -> Result<(), String> {
    clear_error();
    let managed = get_peer(handle)?;
    let label_owned = label.to_owned();
    RUNTIME.block_on(async move { managed.peer.create_data_channel(label_owned).await })
}

pub fn create_offer(handle: u64) -> Result<String, String> {
    clear_error();
    let managed = get_peer(handle)?;
    let sdp = RUNTIME.block_on(async { managed.peer.create_offer().await })?;
    if let Ok(mut mids) = managed.local_mids.lock() {
        *mids = parse_mids_from_sdp(&sdp);
    }
    Ok(sdp)
}

pub fn answer_offer(handle: u64, offer_sdp: &str) -> Result<String, String> {
    clear_error();
    let managed = get_peer(handle)?;
    let mids_from_offer = parse_mids_from_sdp(offer_sdp);
    let sdp_owned = offer_sdp.to_owned();
    let peer_ref = Arc::clone(&managed);
    let answer = RUNTIME.block_on(async move { peer_ref.peer.answer_offer(sdp_owned).await })?;
    if let Ok(mut mids) = managed.local_mids.lock() {
        *mids = if mids_from_offer.is_empty() {
            parse_mids_from_sdp(&answer)
        } else {
            mids_from_offer
        };
    }
    Ok(answer)
}

pub fn accept_answer(handle: u64, answer_sdp: &str) -> Result<(), String> {
    clear_error();
    let managed = get_peer(handle)?;
    let sdp_owned = answer_sdp.to_owned();
    RUNTIME.block_on(async move { managed.peer.accept_answer(sdp_owned).await })
}

pub fn add_ice_candidate(handle: u64, candidate_json: &str) -> Result<(), String> {
    clear_error();
    let managed = get_peer(handle)?;
    let dto: IceCandidateDto = serde_json::from_str(candidate_json)
        .map_err(|e| format!("invalid ICE candidate JSON: {e}"))?;
    if dto.candidate.trim().is_empty() {
        return Ok(());
    }
    let mline_index = dto.sdp_m_line_index.or(dto.sdp_mline_index);
    let mut sdp_mid = dto.sdp_mid.filter(|mid| !mid.is_empty());
    if sdp_mid.is_none() {
        if let (Some(idx), Ok(mids)) = (mline_index, managed.local_mids.lock()) {
            sdp_mid = mids
                .get(usize::from(idx))
                .filter(|m| !m.is_empty())
                .cloned();
        }
        if sdp_mid.is_none() {
            sdp_mid = Some("0".to_owned());
        }
    }
    let candidate = IceCandidate {
        candidate: dto.candidate,
        sdp_mid,
        sdp_mline_index: mline_index.or(Some(0)),
        username_fragment: dto.username_fragment,
    };
    RUNTIME.block_on(async move { managed.peer.add_ice_candidate(candidate).await })
}

pub fn send_bytes(handle: u64, label: &str, data: &[u8]) -> Result<(), String> {
    clear_error();
    let managed = get_peer(handle)?;
    let bytes = Bytes::copy_from_slice(data);
    RUNTIME.block_on(async { managed.peer.send_data(label, bytes).await })
}

pub fn send_text(handle: u64, label: &str, text: &str) -> Result<(), String> {
    clear_error();
    let managed = get_peer(handle)?;
    RUNTIME.block_on(async { managed.peer.send_text(label, text).await })
}

pub fn poll_event_json(handle: u64, timeout_ms: u64) -> Result<Option<String>, String> {
    clear_error();
    let managed = get_peer(handle)?;
    let outcome = RUNTIME.block_on(async {
        tokio::time::timeout(Duration::from_millis(timeout_ms), managed.peer.next_event()).await
    });
    let event_opt = match outcome {
        Err(_) => return Ok(None),
        Ok(Err(e)) => return Err(e),
        Ok(Ok(opt)) => opt,
    };
    let dto = match event_opt {
        None => BridgeEventDto::Closed,
        Some(PeerEvent::IceCandidate(cand)) => BridgeEventDto::IceCandidate {
            candidate: cand.map(|c| IceCandidateDto {
                candidate: c.candidate,
                sdp_mid: c.sdp_mid,
                sdp_m_line_index: c.sdp_mline_index,
                sdp_mline_index: None,
                username_fragment: c.username_fragment,
            }),
        },
        Some(PeerEvent::StateChanged(state)) => BridgeEventDto::StateChanged {
            state: match state {
                PeerState::New => "new",
                PeerState::Connecting => "connecting",
                PeerState::Connected => "connected",
                PeerState::Disconnected => "disconnected",
                PeerState::Failed => "failed",
                PeerState::Closed => "closed",
            },
        },
        Some(PeerEvent::DataChannelOpen { label }) => BridgeEventDto::DataChannelOpen { label },
        Some(PeerEvent::DataChannelClosed { label }) => BridgeEventDto::DataChannelClosed { label },
        Some(PeerEvent::Data {
            label,
            data,
            is_string,
        }) => BridgeEventDto::Data {
            label,
            data_base64: base64::engine::general_purpose::STANDARD.encode(&data),
            is_string,
        },
        Some(PeerEvent::Error { message, reason }) => BridgeEventDto::Error { message, reason },
    };
    serde_json::to_string(&dto)
        .map(Some)
        .map_err(|e| e.to_string())
}

pub fn snapshot_video_frame(handle: u64, after_seq: u64) -> Option<video::DecodedFrame> {
    let managed = get_peer(handle).ok()?;
    managed.frames.snapshot_after(after_seq)
}

pub fn close_peer(handle: u64) {
    clear_error();
    let removed = PEERS.lock().ok().and_then(|mut map| map.remove(&handle));
    if let Some(managed) = removed {
        let _ = RUNTIME.block_on(async move { managed.peer.close().await });
    }
}

pub fn run_nat_test(server: &str) -> Result<String, String> {
    clear_error();
    let dto = RUNTIME.block_on(async {
        tokio::time::timeout(Duration::from_secs(30), nat_probe::probe_nat(server))
            .await
            .map_err(|_| "NAT test timed out".to_owned())?
    })?;
    serde_json::to_string(&dto).map_err(|e| e.to_string())
}

pub fn request_local_network() -> Result<&'static str, String> {
    clear_error();
    nat_probe::trigger_local_network_consent()
}

pub fn open_local_network_settings() -> Result<(), String> {
    clear_error();
    nat_probe::open_macos_local_network_pane()
}
