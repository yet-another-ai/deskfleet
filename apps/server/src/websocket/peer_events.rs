//! Bounded signaling work never blocks the socket reader that delivers SDP answers.
use crate::{AppState, error::ApiError, peers};
use actix_web::web;
use futures_util::{StreamExt, stream::FuturesUnordered};
use serde_json::Value;
use std::{
    collections::HashSet,
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::{Semaphore, mpsc};

const PENDING_EVENTS: usize = 128;
const IN_FLIGHT_EVENTS: usize = 16;
static EVENT_WORK: Semaphore = Semaphore::const_new(256);

#[derive(Debug)]
pub(super) struct PeerEvent {
    pub peer_id: String,
    pub event: Value,
}

pub(crate) struct PeerEvents {
    send: mpsc::Sender<PeerEvent>,
    rejected: Rejections,
    worker: tokio::task::JoinHandle<()>,
    cleanup: tokio::task::JoinHandle<()>,
}

impl PeerEvents {
    pub fn new(state: web::Data<AppState>, machine: String, connection: String) -> Self {
        let (send, receive) = mpsc::channel(PENDING_EVENTS);
        let (rejected, mut rejections) = Rejections::channel(PENDING_EVENTS);
        let cleanup = {
            let state = state.clone();
            let machine = machine.clone();
            let connection = connection.clone();
            actix_web::rt::spawn(async move {
                while let Some(rejection) = rejections.recv().await {
                    let peer_id = &rejection.peer_id;
                    // The ID is untrusted until checked against this registration.
                    // Failed/stale events must not revoke another Machine's grant.
                    if !state.hub.is_current(&machine, &connection).await
                        || state.store.peer_login(peer_id, &machine).await.is_err()
                        || !state.hub.is_current(&machine, &connection).await
                    {
                        continue;
                    }
                    match state.store.revoke_peer(peer_id).await {
                        Ok(peers) => {
                            if let Err(error) =
                                state.hub.revoke(peers, rejection.reason.wire()).await
                            {
                                tracing::warn!(registration_id = %machine, code = %error.code,
                                    "peer signaling rejection delivery failed");
                            }
                        }
                        Err(error) => {
                            let error = ApiError::from(error);
                            tracing::warn!(registration_id = %machine, code = %error.code,
                                "peer signaling rejection failed");
                        }
                    }
                }
            })
        };
        let failed = rejected.clone();
        let worker = actix_web::rt::spawn(run(receive, IN_FLIGHT_EVENTS, move |message| {
            let state = state.clone();
            let machine = machine.clone();
            let connection = connection.clone();
            let failed = failed.clone();
            async move {
                // Waiting for global capacity consumes only this socket's bounded
                // task budget, never its heartbeat/RPC-response reader.
                let _permit = EVENT_WORK
                    .acquire()
                    .await
                    .expect("static semaphore stays open");
                let peer_id = message.peer_id;
                if let Err(error) = peers::daemon_event(
                    &state,
                    &machine,
                    &connection,
                    peer_id.clone(),
                    message.event,
                )
                .await
                {
                    tracing::debug!(registration_id = %machine, code = %error.code,
                        "peer signaling event failed");
                    // A rejected candidate must fail its negotiation rather than
                    // silently leaving a partially signaled connection behind.
                    failed.push(peer_id, RejectionReason::Failed);
                }
            }
        }));
        Self {
            send,
            rejected,
            worker,
            cleanup,
        }
    }

    pub fn push(&self, peer_id: String, event: Value) {
        if let Err(error) = self.send.try_send(PeerEvent { peer_id, event }) {
            let message = error.into_inner();
            // Rejection work is bounded too. If a daemon floods distinct peers
            // beyond both queues, their normal negotiation deadlines still apply.
            self.rejected
                .push(message.peer_id, RejectionReason::Overloaded);
        }
    }
}

#[derive(Clone, Copy)]
enum RejectionReason {
    Overloaded,
    Failed,
}

impl RejectionReason {
    fn wire(self) -> &'static str {
        match self {
            Self::Overloaded => "signaling_overloaded",
            Self::Failed => "signaling_failed",
        }
    }
}

/// Deduplicate queued and currently executing cleanup, so one burst cannot use
/// every rejection slot with the same peer ID. Drop also handles cancellation.
#[derive(Clone)]
struct Rejections {
    send: mpsc::Sender<RejectedPeer>,
    pending: Arc<Mutex<HashSet<String>>>,
    capacity: usize,
}

struct RejectedPeer {
    peer_id: String,
    reason: RejectionReason,
    pending: Arc<Mutex<HashSet<String>>>,
}

impl Rejections {
    fn channel(capacity: usize) -> (Self, mpsc::Receiver<RejectedPeer>) {
        let (send, receive) = mpsc::channel(capacity);
        (
            Self {
                send,
                pending: Arc::default(),
                capacity,
            },
            receive,
        )
    }

    fn push(&self, peer_id: String, reason: RejectionReason) {
        {
            let mut pending = self.pending.lock().expect("peer rejection lock poisoned");
            if pending.len() >= self.capacity || !pending.insert(peer_id.clone()) {
                return;
            }
        }
        // A failed send drops the guard and frees its deduplication slot.
        let _ = self.send.try_send(RejectedPeer {
            peer_id,
            reason,
            pending: self.pending.clone(),
        });
    }
}

impl Drop for RejectedPeer {
    fn drop(&mut self) {
        self.pending
            .lock()
            .expect("peer rejection lock poisoned")
            .remove(&self.peer_id);
    }
}

impl Drop for PeerEvents {
    fn drop(&mut self) {
        // A replaced control socket must not keep consuming global worker slots
        // or publishing late events through its successor's registration.
        self.worker.abort();
        self.cleanup.abort();
    }
}

async fn run<F, Fut>(mut receive: mpsc::Receiver<PeerEvent>, limit: usize, handle: F)
where
    F: Fn(PeerEvent) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut tasks = FuturesUnordered::new();
    let mut open = true;
    loop {
        tokio::select! {
            message = receive.recv(), if open && tasks.len() < limit => match message {
                Some(message) => tasks.push(handle(message)),
                None => open = false,
            },
            _ = tasks.next(), if !tasks.is_empty() => {},
            else => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;

    #[tokio::test]
    async fn rejection_bursts_deduplicate_without_displacing_other_peers() {
        let (send, mut receive) = Rejections::channel(2);
        for _ in 0..10_000 {
            send.push("noisy".into(), RejectionReason::Overloaded);
        }
        send.push("other".into(), RejectionReason::Failed);
        send.push("over-capacity".into(), RejectionReason::Overloaded);
        let noisy = receive.recv().await.unwrap();
        assert_eq!(noisy.peer_id, "noisy");
        assert_eq!(noisy.reason.wire(), "signaling_overloaded");
        // The peer being cleaned still owns one slot, even after being dequeued.
        for _ in 0..100 {
            send.push("noisy".into(), RejectionReason::Overloaded);
        }
        let other = receive.recv().await.unwrap();
        assert_eq!(other.peer_id, "other");
        assert_eq!(other.reason.wire(), "signaling_failed");
        assert!(receive.try_recv().is_err());
        drop(other);
        send.push("later".into(), RejectionReason::Failed);
        let later = receive.recv().await.unwrap();
        assert_eq!(later.peer_id, "later");
        drop(noisy);
        drop(later);
        send.push("noisy".into(), RejectionReason::Failed);
        assert_eq!(receive.recv().await.unwrap().peer_id, "noisy");
        drop(receive);
        send.push("closed".into(), RejectionReason::Failed);
        assert!(send.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn candidate_burst_waits_for_answer_without_rejecting_the_socket() {
        let (send, receive) = mpsc::channel(PENDING_EVENTS);
        let answer = Arc::new(Notify::new());
        let started = Arc::new(AtomicUsize::new(0));
        let completed = Arc::new(AtomicUsize::new(0));
        let worker = {
            let answer = answer.clone();
            let started = started.clone();
            let completed = completed.clone();
            tokio::spawn(run(receive, IN_FLIGHT_EVENTS, move |_| {
                let answer = answer.clone();
                let started = started.clone();
                let completed = completed.clone();
                async move {
                    let ready = answer.notified();
                    started.fetch_add(1, Ordering::SeqCst);
                    // Later candidates observe the already committed answer.
                    if started.load(Ordering::SeqCst) <= IN_FLIGHT_EVENTS {
                        ready.await;
                    }
                    completed.fetch_add(1, Ordering::SeqCst);
                }
            }))
        };
        for n in 0..80 {
            send.try_send(PeerEvent {
                peer_id: format!("display-{}", n % 2),
                event: json!({"kind":"iceCandidate","candidate":{"candidate":"a"}}),
            })
            .unwrap();
        }
        while started.load(Ordering::SeqCst) != IN_FLIGHT_EVENTS {
            tokio::task::yield_now().await;
        }
        assert_eq!(completed.load(Ordering::SeqCst), 0);
        // This represents the SDP response read independently of the worker.
        answer.notify_waiters();
        drop(send);
        tokio::time::timeout(std::time::Duration::from_secs(1), worker)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(completed.load(Ordering::SeqCst), 80);
    }
}
