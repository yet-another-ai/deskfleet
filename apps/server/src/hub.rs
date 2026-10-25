//! Live connection routing. Daemons own peers; WebSocket loss only removes a route.
use crate::error::{ApiError, Result};
use deskfleet_protocol::control::{ControlMessage, PeerActor, PeerAuthorization};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{Mutex, mpsc, oneshot, watch};

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
#[derive(Default)]
struct Routes {
    daemons: HashMap<String, Daemon>,
    clients: HashMap<String, HashMap<String, Client>>,
    pending: HashMap<String, Pending>,
}
#[derive(Clone, Default)]
pub struct Hub {
    inner: Arc<Mutex<Routes>>,
}
impl Hub {
    pub(crate) async fn is_current(&self, machine_id: &str, connection_id: &str) -> bool {
        self.inner
            .lock()
            .await
            .daemons
            .get(machine_id)
            .is_some_and(|d| d.connection_id == connection_id)
    }
    pub async fn online(&self, machine_id: &str) -> bool {
        self.inner.lock().await.daemons.contains_key(machine_id)
    }
    pub(crate) async fn add_daemon(
        &self,
        machine_id: &str,
        connection_id: &str,
        sender: Sender,
        shutdown: watch::Sender<Option<u16>>,
    ) {
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
    }
    pub(crate) async fn remove_daemon(&self, machine_id: &str, connection_id: &str) -> bool {
        let mut routes = self.inner.lock().await;
        if routes
            .daemons
            .get(machine_id)
            .is_none_or(|d| d.connection_id != connection_id)
        {
            return false;
        }
        routes.daemons.remove(machine_id);
        let ids: Vec<_> = routes
            .pending
            .iter()
            .filter(|(_, p)| p.machine_id == machine_id && p.connection_id == connection_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(p) = routes.pending.remove(&id) {
                let _ = p.response.send(Err(ApiError::unavailable()));
            }
        }
        true
    }
    pub(crate) async fn add_client(
        &self,
        login_id: &str,
        user_id: &str,
        connection_id: &str,
        sender: Sender,
        shutdown: watch::Sender<Option<u16>>,
    ) {
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
        let id = uuid::Uuid::new_v4().to_string();
        let (send, receive) = oneshot::channel();
        let daemon = {
            let mut routes = self.inner.lock().await;
            let daemon = routes
                .daemons
                .get(machine_id)
                .cloned()
                .ok_or_else(ApiError::unavailable)?;
            routes.pending.insert(
                id.clone(),
                Pending {
                    machine_id: machine_id.into(),
                    connection_id: daemon.connection_id.clone(),
                    response: send,
                },
            );
            daemon
        };
        if daemon
            .sender
            .try_send(ControlMessage::Request {
                id: id.clone(),
                method: method.into(),
                params,
                actor,
            })
            .is_err()
        {
            self.inner.lock().await.pending.remove(&id);
            return Err(ApiError::unavailable());
        }
        let result = tokio::time::timeout(Duration::from_secs(60), receive).await;
        self.inner.lock().await.pending.remove(&id);
        match result {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ApiError::unavailable()),
            Err(_) => Err(ApiError::new(
                actix_web::http::StatusCode::GATEWAY_TIMEOUT,
                "daemon_timeout",
                "daemon response timed out; check the operation receipt before retrying",
            )),
        }
    }
    pub(crate) async fn response(
        &self,
        machine_id: &str,
        connection_id: &str,
        id: &str,
        result: Result<Value>,
    ) {
        let mut routes = self.inner.lock().await;
        if routes
            .daemons
            .get(machine_id)
            .is_none_or(|d| d.connection_id != connection_id)
        {
            return;
        }
        if routes
            .pending
            .get(id)
            .is_some_and(|p| p.machine_id == machine_id && p.connection_id == connection_id)
            && let Some(p) = routes.pending.remove(id)
        {
            let _ = p.response.send(result);
        }
    }
    pub async fn send_client(&self, login_id: &str, message: ControlMessage) {
        let routes = self.inner.lock().await;
        if let Some(clients) = routes.clients.get(login_id) {
            for client in clients.values() {
                if client.sender.try_send(message.clone()).is_err() {
                    let _ = client.shutdown.send(Some(1012));
                }
            }
        }
    }
    pub async fn notify_users(&self, users: &[String], message: ControlMessage) {
        let routes = self.inner.lock().await;
        for clients in routes.clients.values() {
            for client in clients.values() {
                if users.contains(&client.user_id)
                    && client.sender.try_send(message.clone()).is_err()
                {
                    let _ = client.shutdown.send(Some(1012));
                }
            }
        }
    }
    pub async fn revoke(&self, peers: Vec<PeerAuthorization>, reason: &str) {
        let routes = self.inner.lock().await;
        for peer in peers {
            let message = ControlMessage::PeerRevoked {
                peer_id: peer.peer_id,
                reason: reason.into(),
            };
            if let Some(daemon) = routes.daemons.get(&peer.target_machine.id)
                && daemon.sender.try_send(message.clone()).is_err()
            {
                let _ = daemon.shutdown.send(Some(1012));
            }
            for clients in routes.clients.values() {
                for client in clients.values() {
                    if client.user_id == peer.actor.user_id
                        && client.sender.try_send(message.clone()).is_err()
                    {
                        let _ = client.shutdown.send(Some(1012));
                    }
                }
            }
        }
    }
    pub async fn disconnect_machine(&self, machine_id: &str) {
        if let Some(daemon) = self.inner.lock().await.daemons.get(machine_id) {
            let _ = daemon.shutdown.send(Some(4403));
        }
    }
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
        hub.add_daemon("1", "old", send, shutdown).await;
        let peer:PeerAuthorization=serde_json::from_value(serde_json::json!({"peerId":"peer","serverId":"server","teamId":"team","actor":{"kind":"user","userId":"u","deviceId":"d"},"targetMachine":{"id":"1","originId":"origin","localMachineId":"1"},"purpose":"agent","actions":[],"issuedAt":"now","expiresAt":"later"})).unwrap();
        hub.revoke(vec![peer], "logout").await;
        stopped.changed().await.unwrap();
        assert_eq!(*stopped.borrow(), Some(1012));
        let (send, _receive) = mpsc::channel(1);
        let (shutdown, stopped) = watch::channel(None);
        hub.add_daemon("1", "new", send, shutdown).await;
        assert!(!hub.is_current("1", "old").await);
        assert!(!hub.remove_daemon("1", "old").await);
        assert!(hub.online("1").await);
        hub.disconnect_machine("1").await;
        assert_eq!(*stopped.borrow(), Some(4403));
        assert!(hub.remove_daemon("1", "new").await);
    }
}
