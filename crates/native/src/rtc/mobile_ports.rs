//! Mobile loopback WebRTC port forwarding shared by Android JNI and iOS C FFI.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::runtime::{Builder, Runtime};

use super::{IceCandidate, IceServer, Peer, PeerConfig, PeerEvent, PeerState};

/// Callback invoked with serialized JSON signaling and lifecycle events.
pub type EventEmitter = Arc<dyn Fn(String) + Send + Sync>;

struct MobilePortPeer {
    peer: Arc<Peer>,
    closing: AtomicBool,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum PortCommand {
    #[serde(rename_all = "camelCase")]
    Create {
        peer_id: String,
        #[serde(default)]
        ice_servers: Vec<WireIceServer>,
        #[serde(default)]
        relay_only: bool,
        #[serde(default)]
        local_port: u16,
        target_host: String,
        target_port: u16,
    },
    #[serde(rename_all = "camelCase")]
    Offer { peer_id: String },
    #[serde(rename_all = "camelCase")]
    Answer { peer_id: String, sdp: String },
    #[serde(rename_all = "camelCase")]
    Candidate {
        peer_id: String,
        candidate: WireIceCandidate,
    },
    #[serde(rename_all = "camelCase")]
    Close { peer_id: String },
}

#[derive(Deserialize)]
struct WireIceServer {
    urls: Vec<String>,
    #[serde(default)]
    username: String,
    #[serde(default)]
    credential: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireIceCandidate {
    candidate: String,
    #[serde(default)]
    sdp_mid: Option<String>,
    #[serde(default, alias = "sdpMLineIndex")]
    sdp_mline_index: Option<u16>,
    #[serde(default)]
    username_fragment: Option<String>,
}

static RUNTIME: OnceLock<Result<Runtime, String>> = OnceLock::new();
static PEERS: OnceLock<Mutex<HashMap<String, Arc<MobilePortPeer>>>> = OnceLock::new();
static EMITTER: OnceLock<Mutex<Option<EventEmitter>>> = OnceLock::new();

fn runtime() -> Result<&'static Runtime, String> {
    RUNTIME
        .get_or_init(|| {
            Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .map_err(|error| format!("failed to start port forwarding runtime: {error}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn peers() -> &'static Mutex<HashMap<String, Arc<MobilePortPeer>>> {
    PEERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn emitter_slot() -> &'static Mutex<Option<EventEmitter>> {
    EMITTER.get_or_init(|| Mutex::new(None))
}

/// Register or clear the mobile event callback for port-forwarding peers.
pub fn set_event_emitter(emitter: Option<EventEmitter>) {
    if let Ok(mut guard) = emitter_slot().lock() {
        *guard = emitter;
    }
}

fn emit_json(payload: &Value) {
    let emitter = emitter_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(Arc::clone));
    if let Some(emitter) = emitter {
        emitter(payload.to_string());
    }
}

fn lookup_peer(peer_id: &str) -> Result<Arc<MobilePortPeer>, String> {
    let guard = peers()
        .lock()
        .map_err(|_| "port forwarding registry poisoned".to_owned())?;
    guard
        .get(peer_id)
        .map(Arc::clone)
        .ok_or_else(|| "port forwarding peer not found".to_owned())
}

fn spawn_event_pump(runtime: &Runtime, peer_id: String, entry: Arc<MobilePortPeer>) {
    runtime.spawn(async move {
        loop {
            match entry.peer.next_event().await {
                Ok(Some(event)) => {
                    if entry.closing.load(Ordering::Acquire) {
                        break;
                    }
                    match event {
                        PeerEvent::IceCandidate(Some(candidate)) => emit_json(&json!({
                            "peerId": peer_id,
                            "kind": "iceCandidate",
                            "candidate": {
                                "candidate": candidate.candidate,
                                "sdpMid": candidate.sdp_mid,
                                "sdpMlineIndex": candidate.sdp_mline_index,
                                "usernameFragment": candidate.username_fragment,
                            }
                        })),
                        PeerEvent::DataChannelOpen { label } if label == "deskfleet-ports" => {
                            emit_json(&json!({ "peerId": peer_id, "kind": "open" }));
                        }
                        PeerEvent::DataChannelClosed { label } if label == "deskfleet-ports" => {
                            emit_json(&json!({
                                "peerId": peer_id,
                                "kind": "error",
                                "error": "Port forwarding peer closed",
                            }));
                            break;
                        }
                        PeerEvent::StateChanged(PeerState::Failed | PeerState::Closed) => {
                            emit_json(&json!({
                                "peerId": peer_id,
                                "kind": "error",
                                "error": "Port forwarding peer closed",
                            }));
                            break;
                        }
                        PeerEvent::Error { message, .. } => {
                            emit_json(&json!({
                                "peerId": peer_id,
                                "kind": "error",
                                "error": message,
                            }));
                            break;
                        }
                        _ => {}
                    }
                }
                Ok(None) => {
                    if !entry.closing.load(Ordering::Acquire) {
                        emit_json(&json!({
                            "peerId": peer_id,
                            "kind": "error",
                            "error": "Port forwarding peer closed",
                        }));
                    }
                    break;
                }
                Err(error) => {
                    if !entry.closing.load(Ordering::Acquire) {
                        emit_json(&json!({
                            "peerId": peer_id,
                            "kind": "error",
                            "error": error.to_string(),
                        }));
                    }
                    break;
                }
            }
        }
    });
}

async fn execute_command(rt: &Runtime, command: PortCommand) -> Result<Value, String> {
    match command {
        PortCommand::Create {
            peer_id,
            ice_servers,
            relay_only,
            local_port,
            target_host,
            target_port,
        } => {
            if peer_id.trim().is_empty() {
                return Err("missing port forwarding peer ID".to_owned());
            }
            if target_port == 0 {
                return Err("invalid TCP port".to_owned());
            }
            {
                let guard = peers()
                    .lock()
                    .map_err(|_| "port forwarding registry poisoned".to_owned())?;
                if guard.contains_key(&peer_id) {
                    return Err("duplicate port forwarding peer ID".to_owned());
                }
            }
            let config = PeerConfig {
                ice_servers: ice_servers
                    .into_iter()
                    .map(|server| IceServer {
                        urls: server.urls,
                        username: server.username,
                        credential: server.credential,
                    })
                    .collect(),
                relay_only,
                video: None,
                audio: false,
            };
            let peer = Arc::new(Peer::new(config).await.map_err(|error| error.to_string())?);
            let bound_port = match peer
                .listen_port_forward(local_port, &target_host, target_port)
                .await
            {
                Ok(port) => port,
                Err(error) => {
                    let _ = peer.close().await;
                    return Err(error.to_string());
                }
            };
            let entry = Arc::new(MobilePortPeer {
                peer: Arc::clone(&peer),
                closing: AtomicBool::new(false),
            });
            let inserted = {
                let mut guard = peers()
                    .lock()
                    .map_err(|_| "port forwarding registry poisoned".to_owned())?;
                if guard.contains_key(&peer_id) {
                    false
                } else {
                    guard.insert(peer_id.clone(), Arc::clone(&entry));
                    true
                }
            };
            if !inserted {
                entry.closing.store(true, Ordering::Release);
                let _ = peer.close().await;
                return Err("duplicate port forwarding peer ID".to_owned());
            }
            spawn_event_pump(rt, peer_id, entry);
            Ok(json!({ "localPort": bound_port }))
        }
        PortCommand::Offer { peer_id } => {
            let entry = lookup_peer(&peer_id)?;
            let sdp = entry
                .peer
                .create_offer()
                .await
                .map_err(|error| error.to_string())?;
            Ok(json!({ "sdp": sdp }))
        }
        PortCommand::Answer { peer_id, sdp } => {
            let entry = lookup_peer(&peer_id)?;
            entry
                .peer
                .accept_answer(sdp)
                .await
                .map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true }))
        }
        PortCommand::Candidate { peer_id, candidate } => {
            let entry = lookup_peer(&peer_id)?;
            entry
                .peer
                .add_ice_candidate(IceCandidate {
                    candidate: candidate.candidate,
                    sdp_mid: candidate.sdp_mid,
                    sdp_mline_index: candidate.sdp_mline_index,
                    username_fragment: candidate.username_fragment,
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true }))
        }
        PortCommand::Close { peer_id } => {
            let removed = peers()
                .lock()
                .map_err(|_| "port forwarding registry poisoned".to_owned())?
                .remove(&peer_id);
            if let Some(entry) = removed {
                entry.closing.store(true, Ordering::Release);
                entry
                    .peer
                    .close()
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Ok(json!({ "ok": true }))
        }
    }
}

/// Dispatch one JSON command against the mobile port-forwarding peer registry.
pub fn handle_command(raw_json: &str) -> String {
    let result = (|| -> Result<Value, String> {
        let command = serde_json::from_str::<PortCommand>(raw_json)
            .map_err(|error| format!("invalid port forwarding command: {error}"))?;
        let rt = runtime()?;
        rt.block_on(execute_command(rt, command))
    })();
    match result {
        Ok(value) => json!({ "result": value }).to_string(),
        Err(error) => json!({ "error": error }).to_string(),
    }
}

/// Close and remove all active mobile port-forwarding peers.
pub fn close_all() {
    let drained: Vec<Arc<MobilePortPeer>> = peers()
        .lock()
        .ok()
        .map(|mut guard| guard.drain().map(|(_, entry)| entry).collect())
        .unwrap_or_default();
    if drained.is_empty() {
        return;
    }
    if let Ok(rt) = runtime() {
        rt.block_on(async {
            for entry in drained {
                entry.closing.store(true, Ordering::Release);
                let _ = entry.peer.close().await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    static TEST_LOCK: StdMutex<()> = StdMutex::new(());

    fn parse(raw: String) -> Value {
        serde_json::from_str(&raw).expect("valid JSON response")
    }

    #[test]
    fn mobile_ports_lifecycle_validates_inputs_creates_offers_and_closes_cleanly() {
        let _guard = TEST_LOCK.lock().expect("lock test");
        close_all();

        let bad_json = parse(handle_command("not-json"));
        assert!(bad_json["error"].as_str().is_some());

        let zero_port = parse(handle_command(
            &json!({
                "op": "create",
                "peerId": "p0",
                "iceServers": [],
                "targetHost": "localhost",
                "targetPort": 0,
            })
            .to_string(),
        ));
        assert!(zero_port["error"].as_str().is_some());

        let bad_host = parse(handle_command(
            &json!({
                "op": "create",
                "peerId": "p-bad-host",
                "iceServers": [],
                "targetHost": "example.com",
                "targetPort": 3000,
            })
            .to_string(),
        ));
        assert!(bad_host["error"].as_str().is_some());

        let created = parse(handle_command(
            &json!({
                "op": "create",
                "peerId": "p1",
                "iceServers": [],
                "targetHost": "localhost",
                "targetPort": 5173,
            })
            .to_string(),
        ));
        let local_port = created["result"]["localPort"]
            .as_u64()
            .expect("localPort should be bound");
        assert!(local_port > 0 && local_port <= 65535);

        let offered = parse(handle_command(
            &json!({ "op": "offer", "peerId": "p1" }).to_string(),
        ));
        let sdp = offered["result"]["sdp"]
            .as_str()
            .expect("SDP offer should be returned");
        assert!(sdp.contains("m=application"));

        let closed = parse(handle_command(
            &json!({ "op": "close", "peerId": "p1" }).to_string(),
        ));
        assert_eq!(closed["result"]["ok"], Value::Bool(true));

        let missing = parse(handle_command(
            &json!({ "op": "offer", "peerId": "p1" }).to_string(),
        ));
        assert!(missing["error"].as_str().is_some());

        let idempotent = parse(handle_command(
            &json!({ "op": "close", "peerId": "p1" }).to_string(),
        ));
        assert_eq!(idempotent["result"]["ok"], Value::Bool(true));

        let created2 = parse(handle_command(
            &json!({
                "op": "create",
                "peerId": "p2",
                "iceServers": [],
                "targetHost": "127.0.0.1",
                "targetPort": 3000,
            })
            .to_string(),
        ));
        assert!(created2["result"]["localPort"].as_u64().is_some());
        close_all();
        let after_close_all = parse(handle_command(
            &json!({ "op": "offer", "peerId": "p2" }).to_string(),
        ));
        assert!(after_close_all["error"].as_str().is_some());
    }
}
