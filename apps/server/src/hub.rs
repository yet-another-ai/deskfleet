//! Local sockets with PostgreSQL-backed cross-instance routing.
mod cluster;
mod delivery;
mod wire;

#[cfg(test)]
mod cleanup_tests;
#[cfg(test)]
mod reconcile_tests;

use crate::error::{ApiError, Result};
pub(crate) use cluster::Router;
use deskfleet_control_store::{ControlStore, RealtimeRoute};
use deskfleet_protocol::control::{ControlMessage, PeerActor, PeerAuthorization};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{Mutex, mpsc, oneshot, watch};
use wire::{Audience, Envelope, WireResult};

type Sender = mpsc::Sender<ControlMessage>;
#[derive(Clone)]
struct Daemon {
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
    machine_id: String,
    connection_id: String,
    response: oneshot::Sender<Result<Value>>,
}
struct Forwarded {
    source: String,
    machine_id: String,
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
    pub(crate) async fn is_current(&self, machine_id: &str, connection_id: &str) -> bool {
        let local = self
            .inner
            .lock()
            .await
            .daemons
            .get(machine_id)
            .is_some_and(|d| d.connection_id == connection_id);
        if !local {
            return false;
        }
        match &self.cluster {
            Some(cluster) => {
                cluster.ready()
                    && cluster
                        .store
                        .route_is_current(machine_id, &cluster.id, connection_id)
                        .await
                        .unwrap_or(false)
            }
            None => true,
        }
    }
    pub async fn online(&self, machine_id: &str) -> bool {
        self.route(machine_id).await.ok().flatten().is_some()
    }
    async fn route(&self, machine_id: &str) -> Result<Option<RealtimeRoute>> {
        if let Some(cluster) = &self.cluster {
            cluster.ensure_ready()?;
            return Ok(cluster.store.machine_route(machine_id).await?);
        }
        Ok(self
            .inner
            .lock()
            .await
            .daemons
            .get(machine_id)
            .map(|d| RealtimeRoute {
                node_id: String::new(),
                connection_id: d.connection_id.clone(),
            }))
    }
    pub(crate) async fn add_daemon(
        &self,
        machine_id: &str,
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
            machine_id.into(),
            Daemon {
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
                .claim_machine_route(machine_id, &cluster.id, connection_id)
                .await;
            let previous = match claimed {
                Ok(previous) => previous,
                Err(error) => {
                    self.remove_local_daemon(machine_id, connection_id).await;
                    return Err(error.into());
                }
            };
            if let Some(previous) = previous.filter(|r| r.node_id != cluster.id) {
                self.publish(
                    &previous.node_id,
                    &Envelope::Replace {
                        machine_id: machine_id.into(),
                        connection_id: previous.connection_id,
                    },
                )
                .await?;
            }
            // A concurrent reconnect may have won while this registration awaited SQL.
            if !self.is_current(machine_id, connection_id).await {
                self.remove_local_daemon(machine_id, connection_id).await;
                cluster
                    .store
                    .release_machine_route(machine_id, &cluster.id, connection_id)
                    .await?;
                return Err(ApiError::unavailable());
            }
        }
        Ok(())
    }
    pub(crate) async fn remove_daemon(&self, machine_id: &str, connection_id: &str) -> bool {
        let removed = self.remove_local_daemon(machine_id, connection_id).await;
        match &self.cluster {
            Some(cluster) => cluster
                .store
                .release_machine_route(machine_id, &cluster.id, connection_id)
                .await
                .unwrap_or(false),
            None => removed,
        }
    }
    pub(crate) async fn add_client(
        &self,
        login_id: &str,
        user_id: &str,
        connection_id: &str,
        sender: Sender,
        shutdown: watch::Sender<Option<u16>>,
    ) {
        let _registration = self.registration.lock().await;
        if self.cluster.as_ref().is_some_and(|c| !c.ready()) {
            let _ = shutdown.send(Some(1012));
            return;
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
        machine_id: &str,
        method: &str,
        params: Value,
        actor: Option<PeerActor>,
    ) -> Result<Value> {
        let route = self
            .route(machine_id)
            .await?
            .ok_or_else(ApiError::unavailable)?;
        let id = uuid::Uuid::new_v4().to_string();
        let (send, receive) = oneshot::channel();
        self.inner.lock().await.pending.insert(
            id.clone(),
            Pending {
                machine_id: machine_id.into(),
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
        let sent = if let Some(cluster) = &self.cluster
            && route.node_id != cluster.id
        {
            self.publish(
                &route.node_id,
                &Envelope::Request {
                    source: cluster.id.clone(),
                    machine_id: machine_id.into(),
                    connection_id: route.connection_id,
                    expires_at: deskfleet_control_store::now_ms() + 60_000,
                    message,
                },
            )
            .await
            .and_then(|sent| {
                if sent {
                    Ok(())
                } else {
                    Err(ApiError::unavailable())
                }
            })
        } else {
            self.send_request(machine_id, &route.connection_id, message)
                .await
        };
        if let Err(error) = sent {
            self.inner.lock().await.pending.remove(&id);
            return Err(error);
        }
        let result = tokio::time::timeout(Duration::from_secs(60), receive).await;
        self.inner.lock().await.pending.remove(&id);
        match result {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ApiError::unavailable()),
            Err(_) => Err(timeout_error()),
        }
    }
    pub(crate) async fn response(
        &self,
        machine_id: &str,
        connection_id: &str,
        id: &str,
        result: Result<Value>,
    ) {
        if !self.is_current(machine_id, connection_id).await {
            return;
        }
        let forwarded = {
            let mut routes = self.inner.lock().await;
            if routes
                .pending
                .get(id)
                .is_some_and(|p| p.machine_id == machine_id && p.connection_id == connection_id)
            {
                if let Some(pending) = routes.pending.remove(id) {
                    let _ = pending.response.send(result);
                }
                return;
            }
            if routes
                .forwarded
                .get(id)
                .is_some_and(|p| p.machine_id == machine_id && p.connection_id == connection_id)
            {
                routes.forwarded.remove(id)
            } else {
                None
            }
        };
        if let Some(forwarded) = forwarded {
            let reply = Envelope::Response {
                id: id.into(),
                machine_id: machine_id.into(),
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
    pub async fn disconnect_machine(&self, machine_id: &str) -> Result<()> {
        self.broadcast(Envelope::Disconnect {
            audience: Audience::Machine(machine_id.into()),
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
    async fn saturated_revocation_uses_independent_shutdown_and_replaced_route_is_isolated() {
        let hub = Hub::default();
        let (send, _receive) = mpsc::channel(1);
        let (shutdown, mut stopped) = watch::channel(None);
        send.try_send(ControlMessage::Ping).unwrap();
        hub.add_daemon("1", "old", send, shutdown).await.unwrap();
        let peer: PeerAuthorization = serde_json::from_value(serde_json::json!({"peerId":"peer","serverId":"server","teamId":"team","actor":{"kind":"user","userId":"u","deviceId":"d"},"targetMachine":{"id":"1","originId":"origin","localMachineId":"1"},"purpose":"agent","actions":[],"issuedAt":"now","expiresAt":"later"})).unwrap();
        hub.revoke(vec![peer], "logout").await.unwrap();
        stopped.changed().await.unwrap();
        assert_eq!(*stopped.borrow(), Some(1012));
        let (send, _receive) = mpsc::channel(1);
        let (shutdown, stopped) = watch::channel(None);
        hub.add_daemon("1", "new", send, shutdown).await.unwrap();
        assert!(!hub.is_current("1", "old").await);
        assert!(!hub.remove_daemon("1", "old").await);
        assert!(hub.online("1").await);
        hub.disconnect_machine("1").await.unwrap();
        assert_eq!(*stopped.borrow(), Some(4403));
        assert!(hub.remove_daemon("1", "new").await);
    }
}
