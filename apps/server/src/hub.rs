//! Local sockets with PostgreSQL-backed cross-instance routing.
mod cluster;
mod delivery;
pub(crate) mod outbox;
mod wire;

#[cfg(test)]
mod cleanup_tests;
#[cfg(test)]
mod reconcile_tests;

use crate::error::{ApiError, Result};
pub(crate) use cluster::Router;
use deskfleet_control_store::{ControlStore, RealtimeRoute};
use deskfleet_protocol::control::{ControlMessage, PeerActor, PeerAuthorization};
#[cfg(test)]
use outbox::testing as mpsc;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{Mutex, oneshot, watch};
use wire::{Audience, Envelope, WireResult};

type Sender = outbox::Sender;
#[derive(Clone)]
struct Daemon {
    team_id: String,
    public_machine_id: String,
    connection_id: String,
    sender: Sender,
    shutdown: watch::Sender<Option<u16>>,
}
struct Client {
    user_id: String,
    sender: Sender,
    shutdown: watch::Sender<Option<u16>>,
}
struct Pending {
    registration_id: String,
    connection_id: String,
    response: oneshot::Sender<Result<Value>>,
}
struct Forwarded {
    source: String,
    registration_id: String,
    connection_id: String,
    expires_at: i64,
}
#[derive(Default)]
struct Routes {
    daemons: HashMap<String, Daemon>,
    clients: HashMap<String, HashMap<String, Client>>,
    pending: HashMap<String, Pending>,
    forwarded: HashMap<String, Forwarded>,
}
#[derive(Clone, Default)]
pub struct Hub {
    inner: Arc<Mutex<Routes>>,
    registration: Arc<Mutex<()>>,
    cluster: Option<cluster::Cluster>,
}
impl Hub {
    pub(crate) async fn connect(store: ControlStore) -> Result<(Self, Router)> {
        cluster::connect(store).await
    }
    pub(crate) async fn is_current(&self, registration_id: &str, connection_id: &str) -> bool {
        let local = self
            .inner
            .lock()
            .await
            .daemons
            .get(registration_id)
            .is_some_and(|d| d.connection_id == connection_id);
        if !local {
            return false;
        }
        match &self.cluster {
            Some(cluster) => {
                cluster.ready()
                    && cluster
                        .store
                        .route_is_current(registration_id, &cluster.id, connection_id)
                        .await
                        .unwrap_or(false)
            }
            None => true,
        }
    }
    pub async fn online(&self, registration_id: &str) -> bool {
        self.route(registration_id).await.ok().flatten().is_some()
    }
    pub(crate) async fn online_machines(
        &self,
        machines: &[String],
    ) -> std::collections::HashSet<String> {
        if let Some(cluster) = &self.cluster {
            if cluster.ensure_ready().is_err() {
                return Default::default();
            }
            return cluster
                .store
                .online_machines(machines)
                .await
                .unwrap_or_default();
        }
        let routes = self.inner.lock().await;
        machines
            .iter()
            .filter(|id| routes.daemons.contains_key(*id))
            .cloned()
            .collect()
    }
    async fn route(&self, registration_id: &str) -> Result<Option<RealtimeRoute>> {
        if let Some(cluster) = &self.cluster {
            cluster.ensure_ready()?;
            return Ok(cluster.store.machine_route(registration_id).await?);
        }
        Ok(self
            .inner
            .lock()
            .await
            .daemons
            .get(registration_id)
            .map(|d| RealtimeRoute {
                node_id: String::new(),
                connection_id: d.connection_id.clone(),
            }))
    }
    pub(crate) async fn add_daemon(
        &self,
        registration_id: &str,
        team_id: &str,
        public_machine_id: &str,
        connection_id: &str,
        sender: Sender,
        shutdown: watch::Sender<Option<u16>>,
    ) -> Result<()> {
        // Serialize local registration with its SQL claim, so two local
        // reconnects cannot leave the database pointing at a replaced sender.
        let _registration = self.registration.lock().await;
        // Install locally before publishing the route: once another node sees it,
        // its requests must already have a local destination.
        if let Some(cluster) = &self.cluster {
            cluster.ensure_ready()?;
        }
        let previous = self.inner.lock().await.daemons.insert(
            registration_id.into(),
            Daemon {
                team_id: team_id.into(),
                public_machine_id: public_machine_id.into(),
                connection_id: connection_id.into(),
                sender,
                shutdown,
            },
        );
        if let Some(previous) = previous {
            let _ = previous.shutdown.send(Some(1012));
        }
        if let Some(cluster) = &self.cluster {
            let claimed = cluster
                .store
                .claim_machine_route(registration_id, &cluster.id, connection_id)
                .await;
            let previous = match claimed {
                Ok(previous) => previous,
                Err(error) => {
                    self.remove_local_daemon(registration_id, connection_id)
                        .await;
                    return Err(error.into());
                }
            };
            if let Some(previous) = previous.filter(|r| r.node_id != cluster.id) {
                self.publish(
                    &previous.node_id,
                    &Envelope::Replace {
                        registration_id: registration_id.into(),
                        connection_id: previous.connection_id,
                    },
                )
                .await?;
            }
            // A concurrent reconnect may have won while this registration awaited SQL.
            if !self.is_current(registration_id, connection_id).await {
                self.remove_local_daemon(registration_id, connection_id)
                    .await;
                cluster
                    .store
                    .release_machine_route(registration_id, &cluster.id, connection_id)
                    .await?;
                return Err(ApiError::unavailable());
            }
        }
        Ok(())
    }
    pub(crate) async fn remove_daemon(&self, registration_id: &str, connection_id: &str) -> bool {
        let removed = self
            .remove_local_daemon(registration_id, connection_id)
            .await;
        let Some(cluster) = &self.cluster else {
            return removed;
        };
        match cluster
            .store
            .release_machine_route(registration_id, &cluster.id, connection_id)
            .await
        {
            Ok(released) => released,
            Err(error) => {
                // Local socket is already gone; swallowing this leaves the row
                // advertised while this process keeps renewing its node lease.
                tracing::warn!(
                    error = %error,
                    registration_id,
                    "failed to release machine route; marking realtime routing unhealthy"
                );
                cluster.mark_unhealthy();
                let _registration = self.registration.lock().await;
                self.fail_local().await;
                removed
            }
        }
    }
    pub(crate) async fn add_client(
        &self,
        login_id: &str,
        user_id: &str,
        connection_id: &str,
        sender: Sender,
        shutdown: watch::Sender<Option<u16>>,
    ) -> Result<()> {
        let _registration = self.registration.lock().await;
        if let Some(cluster) = &self.cluster {
            cluster.ensure_ready()?;
        }
        self.inner
            .lock()
            .await
            .clients
            .entry(login_id.into())
            .or_default()
            .insert(
                connection_id.into(),
                Client {
                    user_id: user_id.into(),
                    sender,
                    shutdown,
                },
            );
        Ok(())
    }
    pub(crate) async fn remove_client(&self, login_id: &str, connection_id: &str) {
        let mut routes = self.inner.lock().await;
        if let Some(clients) = routes.clients.get_mut(login_id) {
            clients.remove(connection_id);
            if clients.is_empty() {
                routes.clients.remove(login_id);
            }
        }
    }
    pub async fn request(
        &self,
        registration_id: &str,
        method: &str,
        params: Value,
        actor: Option<PeerActor>,
    ) -> Result<Value> {
        self.request_with_timeout(
            registration_id,
            method,
            params,
            actor,
            Duration::from_secs(60),
        )
        .await
    }
    pub(crate) async fn request_with_timeout(
        &self,
        registration_id: &str,
        method: &str,
        params: Value,
        actor: Option<PeerActor>,
        timeout: Duration,
    ) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let result = tokio::time::timeout(timeout, async {
            let expires_at = deskfleet_control_store::now_ms().saturating_add(
                i64::try_from(timeout.as_millis()).map_err(|_| ApiError::internal())?,
            );
            let route = self
                .route(registration_id)
                .await?
                .ok_or_else(ApiError::unavailable)?;
            let (send, receive) = oneshot::channel();
            self.inner.lock().await.pending.insert(
                id.clone(),
                Pending {
                    registration_id: registration_id.into(),
                    connection_id: route.connection_id.clone(),
                    response: send,
                },
            );
            let message = ControlMessage::Request {
                id: id.clone(),
                method: method.into(),
                params,
                actor,
            };
            if let Some(cluster) = &self.cluster
                && route.node_id != cluster.id
            {
                if !self
                    .publish(
                        &route.node_id,
                        &Envelope::Request {
                            source: cluster.id.clone(),
                            registration_id: registration_id.into(),
                            connection_id: route.connection_id,
                            expires_at,
                            message,
                        },
                    )
                    .await?
                {
                    return Err(ApiError::unavailable());
                }
            } else {
                self.send_request(registration_id, &route.connection_id, message)
                    .await?;
            }
            receive.await.map_err(|_| ApiError::unavailable())?
        })
        .await;
        // Keep cleanup outside the timed future so discovery timeouts retire pending RPCs.
        self.inner.lock().await.pending.remove(&id);
        result.map_err(|_| timeout_error())?
    }
    pub(crate) async fn response(
        &self,
        registration_id: &str,
        connection_id: &str,
        id: &str,
        result: Result<Value>,
    ) {
        if !self.is_current(registration_id, connection_id).await {
            return;
        }
        let forwarded = {
            let mut routes = self.inner.lock().await;
            if routes.pending.get(id).is_some_and(|p| {
                p.registration_id == registration_id && p.connection_id == connection_id
            }) {
                if let Some(pending) = routes.pending.remove(id) {
                    let _ = pending.response.send(result);
                }
                return;
            }
            if routes.forwarded.get(id).is_some_and(|p| {
                p.registration_id == registration_id && p.connection_id == connection_id
            }) {
                routes.forwarded.remove(id)
            } else {
                None
            }
        };
        if let Some(forwarded) = forwarded {
            let reply = Envelope::Response {
                id: id.into(),
                registration_id: registration_id.into(),
                connection_id: connection_id.into(),
                result: WireResult::from(result),
            };
            if self.publish(&forwarded.source, &reply).await.is_err() {
                tracing::warn!("cross-instance RPC response delivery failed");
            }
        }
    }
    pub async fn send_client(&self, login_id: &str, message: ControlMessage) -> Result<()> {
        self.broadcast(Envelope::Notify {
            audience: Audience::Login(login_id.into()),
            message,
        })
        .await
    }
    pub async fn notify_users(&self, users: &[String], message: ControlMessage) -> Result<()> {
        self.broadcast(Envelope::Notify {
            audience: Audience::Users(users.into()),
            message,
        })
        .await
    }
    pub async fn revoke(&self, peers: Vec<PeerAuthorization>, reason: &str) -> Result<()> {
        if peers.is_empty() {
            return Ok(());
        }
        self.broadcast(Envelope::Revoke {
            peers,
            reason: reason.into(),
        })
        .await
    }
    pub async fn disconnect_machine(&self, registration_id: &str) -> Result<()> {
        self.broadcast(Envelope::Disconnect {
            audience: Audience::Machine(registration_id.into()),
        })
        .await
    }
    pub async fn disconnect_login(&self, login_id: &str) -> Result<()> {
        self.broadcast(Envelope::Disconnect {
            audience: Audience::Login(login_id.into()),
        })
        .await
    }
    pub async fn disconnect_user(&self, user_id: &str) -> Result<()> {
        self.broadcast(Envelope::Disconnect {
            audience: Audience::Users(vec![user_id.into()]),
        })
        .await
    }
}
fn timeout_error() -> ApiError {
    ApiError::new(
        actix_web::http::StatusCode::GATEWAY_TIMEOUT,
        "daemon_timeout",
        "daemon response timed out; check the operation receipt before retrying",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn saturated_revocation_requests_reconciliation_and_preserves_machine_presence() {
        let hub = Hub::default();
        let (send, mut receive) = outbox::channel(1);
        let (shutdown, stopped) = watch::channel(None);
        send.try_send(ControlMessage::Ping).unwrap();
        hub.add_daemon("1", "team", "1", "old", send, shutdown)
            .await
            .unwrap();
        let peer: PeerAuthorization = serde_json::from_value(serde_json::json!({"peerId":"peer","serverId":"server","teamId":"team","actor":{"kind":"user","userId":"u","deviceId":"d"},"targetMachine":{"id":"1","originId":"origin","localMachineId":"1"},"transport":"webrtc","purpose":"agent","actions":[],"issuedAt":"now","expiresAt":"later"})).unwrap();
        hub.revoke(vec![peer], "logout").await.unwrap();
        assert_eq!(*stopped.borrow(), None);
        assert!(hub.online("1").await);
        assert!(matches!(
            receive.recv().await,
            Some(outbox::Outbound::Reconcile)
        ));
        assert!(matches!(
            receive.recv().await,
            Some(outbox::Outbound::Message(message)) if matches!(*message, ControlMessage::Ping)
        ));
        let (send, _receive) = mpsc::channel(1);
        let (shutdown, stopped) = watch::channel(None);
        hub.add_daemon("1", "team", "1", "new", send, shutdown)
            .await
            .unwrap();
        assert!(!hub.is_current("1", "old").await);
        assert!(!hub.remove_daemon("1", "old").await);
        assert!(hub.online("1").await);
        hub.disconnect_machine("1").await.unwrap();
        assert_eq!(*stopped.borrow(), Some(4403));
        assert!(hub.remove_daemon("1", "new").await);
    }

    #[tokio::test]
    async fn saturated_request_reports_busy_without_taking_machine_offline() {
        let hub = Hub::default();
        let (send, mut receive) = mpsc::channel(1);
        let (shutdown, stopped) = watch::channel(None);
        send.try_send(ControlMessage::Ping).unwrap();
        hub.add_daemon("1", "team", "machine", "socket", send, shutdown)
            .await
            .unwrap();
        let error = hub
            .send_request("1", "socket", ControlMessage::Ping)
            .await
            .unwrap_err();
        assert_eq!(error.code, "machine_busy");
        assert_eq!(*stopped.borrow(), None);
        assert!(hub.online("1").await);
        assert!(hub.is_current("1", "socket").await);
        assert!(matches!(receive.recv().await, Some(ControlMessage::Ping)));
        assert!(matches!(
            receive.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn streaming_history_notifications_do_not_disconnect_a_slow_client() {
        let hub = Hub::default();
        let (send, mut receive) = mpsc::channel(1);
        let (shutdown, stopped) = watch::channel(None);
        hub.add_client("login", "user", "connection", send, shutdown)
            .await
            .unwrap();
        for session in 0..1_000 {
            hub.notify_users(
                &["user".into()],
                ControlMessage::CatalogChanged {
                    team_id: "team".into(),
                    machine_id: "machine".into(),
                    session_id: Some(session.to_string()),
                },
            )
            .await
            .unwrap();
        }
        hub.send_client(
            "login",
            ControlMessage::PeerRevoked {
                peer_id: "peer".into(),
                reason: "closed".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(*stopped.borrow(), None);
        assert!(matches!(
            receive.recv().await,
            Some(ControlMessage::PeerRevoked { .. })
        ));
        assert!(matches!(
            receive.recv().await,
            Some(ControlMessage::CatalogChanged {
                session_id: None,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn distinct_hint_overflow_reconnects_only_its_viewer_and_keeps_daemon_rpc_live() {
        let hub = Hub::default();
        let (daemon, mut daemon_messages) = mpsc::channel(1);
        let (shutdown, daemon_stopped) = watch::channel(None);
        hub.add_daemon(
            "daemon",
            "team",
            "machine",
            "daemon-socket",
            daemon,
            shutdown,
        )
        .await
        .unwrap();
        let (slow, mut slow_messages) = outbox::channel(2);
        let (shutdown, slow_stopped) = watch::channel(None);
        hub.add_client("login", "user", "slow", slow, shutdown)
            .await
            .unwrap();
        let (fast, mut fast_messages) = mpsc::channel(2);
        let (shutdown, fast_stopped) = watch::channel(None);
        hub.add_client("login", "user", "fast", fast, shutdown)
            .await
            .unwrap();
        for machine in 0..3 {
            hub.notify_users(
                &["user".into()],
                ControlMessage::CatalogChanged {
                    team_id: "team".into(),
                    machine_id: machine.to_string(),
                    session_id: None,
                },
            )
            .await
            .unwrap();
            assert!(matches!(
                fast_messages.recv().await,
                Some(ControlMessage::CatalogChanged { .. })
            ));
        }
        assert!(matches!(
            slow_messages.recv().await,
            Some(outbox::Outbound::Reconnect)
        ));
        assert!(slow_messages.recv().await.is_none());
        assert_eq!(
            *slow_stopped.borrow(),
            None,
            "the viewer socket consumes its own reconnect marker"
        );
        assert_eq!(*fast_stopped.borrow(), None);
        assert_eq!(*daemon_stopped.borrow(), None);
        assert!(hub.online("daemon").await);
        assert!(hub.is_current("daemon", "daemon-socket").await);
        match daemon_messages.try_recv_outbound() {
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {}
            Ok(outbox::Outbound::Reconnect) => panic!("viewer overflow reconnected the daemon"),
            Ok(outbox::Outbound::Message(message))
                if matches!(*message, ControlMessage::PeerRevoked { .. }) =>
            {
                panic!("viewer overflow revoked a peer")
            }
            Ok(outbox::Outbound::Message(message)) => {
                panic!("viewer overflow queued {message:?} on the daemon")
            }
            Ok(outbox::Outbound::Reconcile) => panic!("viewer overflow reconciled the daemon"),
            Err(error) => panic!("viewer overflow closed the daemon queue: {error}"),
        }

        let (replacement, mut replacement_messages) = mpsc::channel(1);
        let (shutdown, _) = watch::channel(None);
        hub.add_client("login", "user", "replacement", replacement, shutdown)
            .await
            .unwrap();
        hub.remove_client("login", "slow").await;
        hub.send_client("login", ControlMessage::Ping)
            .await
            .unwrap();
        assert!(matches!(
            replacement_messages.recv().await,
            Some(ControlMessage::Ping)
        ));
        assert!(matches!(
            fast_messages.recv().await,
            Some(ControlMessage::Ping)
        ));
        assert_daemon_rpc(&hub, &mut daemon_messages).await;
    }

    #[tokio::test]
    async fn a_slow_viewers_candidate_burst_does_not_block_revocation_other_viewers_or_rpc() {
        let hub = Hub::default();
        let (daemon, mut daemon_messages) = mpsc::channel(1);
        let (shutdown, daemon_stopped) = watch::channel(None);
        hub.add_daemon(
            "daemon",
            "team",
            "machine",
            "daemon-socket",
            daemon,
            shutdown,
        )
        .await
        .unwrap();
        let (slow, mut slow_messages) = mpsc::channel(128);
        let (shutdown, slow_stopped) = watch::channel(None);
        hub.add_client("slow-login", "user", "slow", slow, shutdown)
            .await
            .unwrap();
        let (fast, mut fast_messages) = mpsc::channel(1);
        let (shutdown, fast_stopped) = watch::channel(None);
        hub.add_client("fast-login", "user", "fast", fast, shutdown)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            for candidate in 0..512 {
                hub.notify_users(&["user".into()], ControlMessage::PeerEvent {
                    peer_id: "peer".into(),
                    event: serde_json::json!({"kind": "iceCandidate", "candidate": {"candidate": candidate.to_string()}}),
                }).await.unwrap();
                assert!(matches!(fast_messages.recv().await, Some(ControlMessage::PeerEvent { .. })));
            }
            hub.notify_users(&["user".into()], ControlMessage::PeerRevoked {
                peer_id: "peer".into(), reason: "revoked".into(),
            }).await.unwrap();
        }).await.expect("candidate delivery must never wait for the critical queue deadline");
        assert!(matches!(
            slow_messages.recv().await,
            Some(ControlMessage::PeerRevoked { .. })
        ));
        assert!(matches!(
            fast_messages.recv().await,
            Some(ControlMessage::PeerRevoked { .. })
        ));
        assert_eq!(*slow_stopped.borrow(), None);
        assert_eq!(*fast_stopped.borrow(), None);
        assert_eq!(*daemon_stopped.borrow(), None);
        assert_daemon_rpc(&hub, &mut daemon_messages).await;
    }

    async fn assert_daemon_rpc(hub: &Hub, messages: &mut mpsc::Receiver) {
        let request = hub.request("daemon", "test", serde_json::json!({}), None);
        tokio::pin!(request);
        assert!(futures_util::poll!(&mut request).is_pending());
        let Some(ControlMessage::Request { id, .. }) = messages.recv().await else {
            panic!("daemon must receive the RPC");
        };
        hub.response(
            "daemon",
            "daemon-socket",
            &id,
            Ok(serde_json::json!("completed")),
        )
        .await;
        assert_eq!(request.await.unwrap(), serde_json::json!("completed"));
        assert!(hub.online("daemon").await);
    }

    #[tokio::test]
    async fn add_client_stores_socket_when_routing_is_local_only() {
        let hub = Hub::default();
        let (send, _receive) = mpsc::channel(1);
        let (shutdown, stopped) = watch::channel(None);
        hub.add_client("login", "user", "connection", send, shutdown)
            .await
            .unwrap();
        assert!(stopped.borrow().is_none());
        hub.remove_client("login", "connection").await;
    }
}
