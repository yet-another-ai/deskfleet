//! Mobile loopback WebRTC port forwarding shared by Android JNI and iOS C FFI.

use std::collections::hash_map::{Entry, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock};

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
        ice_servers: Vec<IceServer>,
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
        candidate: IceCandidate,
    },
    #[serde(rename_all = "camelCase")]
    Close { peer_id: String },
}

static RUNTIME: OnceLock<Result<Runtime, String>> = OnceLock::new();
static PEERS: LazyLock<Mutex<HashMap<String, Arc<MobilePortPeer>>>> =
    LazyLock::new(Default::default);
static EMITTER: Mutex<Option<EventEmitter>> = Mutex::new(None);

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

fn lock_peers() -> Result<MutexGuard<'static, HashMap<String, Arc<MobilePortPeer>>>, String> {
    PEERS
        .lock()
        .map_err(|_| "port forwarding registry poisoned".to_owned())
}

/// Register or clear the mobile event callback for port-forwarding peers.
pub fn set_event_emitter(emitter: Option<EventEmitter>) {
    if let Ok(mut guard) = EMITTER.lock() {
        *guard = emitter;
    }
}

fn emit_json(payload: &Value) {
    let emitter = EMITTER
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(Arc::clone));
    if let Some(emitter) = emitter {
        emitter(payload.to_string());
    }
}

fn emit_error(peer_id: &str, error: impl Into<String>) {
    emit_json(&json!({ "peerId": peer_id, "kind": "error", "error": error.into() }));
}

fn lookup_peer(peer_id: &str) -> Result<Arc<MobilePortPeer>, String> {
    lock_peers()?
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
                            "candidate": candidate,
                        })),
                        PeerEvent::DataChannelOpen { label } if label == "deskfleet-ports" => {
                            emit_json(&json!({ "peerId": peer_id, "kind": "open" }));
                        }
                        PeerEvent::DataChannelClosed { label } if label == "deskfleet-ports" => {
                            emit_error(&peer_id, "Port forwarding peer closed");
                            break;
                        }
                        PeerEvent::StateChanged(PeerState::Failed | PeerState::Closed) => {
                            emit_error(&peer_id, "Port forwarding peer closed");
                            break;
                        }
                        PeerEvent::Error { message, .. } => {
                            emit_error(&peer_id, message);
                            break;
                        }
                        _ => {}
                    }
                }
                Ok(None) => {
                    if !entry.closing.load(Ordering::Acquire) {
                        emit_error(&peer_id, "Port forwarding peer closed");
                    }
                    break;
                }
                Err(error) => {
                    if !entry.closing.load(Ordering::Acquire) {
                        emit_error(&peer_id, error.to_string());
                    }
                    break;
                }
            }
        }
        if let Ok(mut guard) = lock_peers()
            && matches!(guard.get(&peer_id), Some(stored) if Arc::ptr_eq(stored, &entry))
        {
            guard.remove(&peer_id);
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
            super::ports::validate_target(&target_host, target_port)
                .map_err(|error| error.to_string())?;
            if lock_peers()?.contains_key(&peer_id) {
                return Err("duplicate port forwarding peer ID".to_owned());
            }
            let config = PeerConfig {
                ice_servers,
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
            let inserted = match lock_peers()?.entry(peer_id.clone()) {
                Entry::Vacant(slot) => {
                    slot.insert(Arc::clone(&entry));
                    true
                }
                Entry::Occupied(_) => false,
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
            let sdp = lookup_peer(&peer_id)?
                .peer
                .create_offer()
                .await
                .map_err(|error| error.to_string())?;
            Ok(json!({ "sdp": sdp }))
        }
        PortCommand::Answer { peer_id, sdp } => {
            lookup_peer(&peer_id)?
                .peer
                .accept_answer(sdp)
                .await
                .map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true }))
        }
        PortCommand::Candidate { peer_id, candidate } => {
            lookup_peer(&peer_id)?
                .peer
                .add_ice_candidate(candidate)
                .await
                .map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true }))
        }
        PortCommand::Close { peer_id } => {
            let removed = lock_peers()?.remove(&peer_id);
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
    let drained: Vec<Arc<MobilePortPeer>> = lock_peers()
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

    fn call(payload: Value) -> Value {
        serde_json::from_str(&handle_command(&payload.to_string())).expect("valid JSON response")
    }

    #[test]
    fn mobile_ports_lifecycle_validates_inputs_creates_offers_and_closes_cleanly() {
        let _guard = TEST_LOCK.lock().expect("lock test");
        close_all();

        let bad_json: Value =
            serde_json::from_str(&handle_command("not-json")).expect("valid JSON");
        assert!(bad_json["error"].as_str().is_some());

        for bad in [
            json!({ "op": "create", "peerId": "p0", "targetHost": "localhost", "targetPort": 0 }),
            json!({ "op": "create", "peerId": "p-bad-host", "targetHost": "example.com", "targetPort": 3000 }),
        ] {
            assert!(call(bad)["error"].as_str().is_some());
        }

        let created = call(
            json!({ "op": "create", "peerId": "p1", "targetHost": "localhost", "targetPort": 5173 }),
        );
        let local_port = created["result"]["localPort"]
            .as_u64()
            .expect("localPort should be bound");
        assert!(local_port > 0 && local_port <= 65535);

        let offered = call(json!({ "op": "offer", "peerId": "p1" }));
        assert!(
            offered["result"]["sdp"]
                .as_str()
                .expect("SDP offer")
                .contains("m=application")
        );

        assert_eq!(
            call(json!({ "op": "close", "peerId": "p1" }))["result"]["ok"],
            Value::Bool(true)
        );
        assert!(
            call(json!({ "op": "offer", "peerId": "p1" }))["error"]
                .as_str()
                .is_some()
        );
        assert_eq!(
            call(json!({ "op": "close", "peerId": "p1" }))["result"]["ok"],
            Value::Bool(true)
        );

        let created2 = call(
            json!({ "op": "create", "peerId": "p2", "targetHost": "127.0.0.1", "targetPort": 3000 }),
        );
        assert!(created2["result"]["localPort"].as_u64().is_some());
        close_all();
        assert!(
            call(json!({ "op": "offer", "peerId": "p2" }))["error"]
                .as_str()
                .is_some()
        );
    }
}
