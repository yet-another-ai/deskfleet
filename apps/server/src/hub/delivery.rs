use super::*;

impl Hub {
    pub(super) async fn send_request(
        &self,
        machine: &str,
        connection: &str,
        message: ControlMessage,
    ) -> Result<()> {
        let _registration = self.registration.lock().await;
        self.send_current(machine, connection, message).await
    }

    #[tracing::instrument(skip_all, fields(machine_id = machine))]
    pub(crate) async fn reconcile_daemon(&self, machine: &str, connection: &str) -> Result<()> {
        // A peer offer must not overtake a snapshot that predates its grant.
        // The same gate also fences local connection replacement and lease reset.
        let _registration = self.registration.lock().await;
        let cluster = self.cluster.as_ref().ok_or_else(ApiError::internal)?;
        cluster.ensure_ready()?;
        let peers = cluster.store.valid_machine_peers(machine).await?;
        self.send_current(
            machine,
            connection,
            ControlMessage::ReconcilePeers { peers },
        )
        .await
    }

    /// Caller holds registration through the database check and queue insertion.
    async fn send_current(
        &self,
        machine: &str,
        connection: &str,
        message: ControlMessage,
    ) -> Result<()> {
        if !self.is_current(machine, connection).await {
            return Err(ApiError::unavailable());
        }
        let routes = self.inner.lock().await;
        let daemon = routes
            .daemons
            .get(machine)
            .filter(|d| d.connection_id == connection)
            .ok_or_else(ApiError::unavailable)?;
        daemon
            .sender
            .try_send(message)
            .map_err(|_| ApiError::unavailable())
    }
    pub(super) async fn dispatch(&self, envelope: Envelope) -> Result<()> {
        match envelope {
            Envelope::Request {
                source,
                machine_id,
                connection_id,
                expires_at,
                message,
            } => {
                let ControlMessage::Request { id, .. } = &message else {
                    return Err(ApiError::internal());
                };
                let id = id.clone();
                if expires_at <= deskfleet_control_store::now_ms() {
                    return Ok(());
                }
                self.inner.lock().await.forwarded.insert(
                    id.clone(),
                    Forwarded {
                        source: source.clone(),
                        machine_id: machine_id.clone(),
                        connection_id: connection_id.clone(),
                        expires_at,
                    },
                );
                if let Err(error) = self
                    .send_request(&machine_id, &connection_id, message)
                    .await
                {
                    self.inner.lock().await.forwarded.remove(&id);
                    self.publish(
                        &source,
                        &Envelope::Response {
                            id,
                            machine_id,
                            connection_id,
                            result: WireResult::from(Err(error)),
                        },
                    )
                    .await?;
                }
            }
            Envelope::Response {
                id,
                machine_id,
                connection_id,
                result,
            } => {
                let current = self
                    .route(&machine_id)
                    .await?
                    .is_some_and(|r| r.connection_id == connection_id);
                let mut routes = self.inner.lock().await;
                if routes
                    .pending
                    .get(&id)
                    .is_some_and(|p| p.machine_id == machine_id && p.connection_id == connection_id)
                    && let Some(pending) = routes.pending.remove(&id)
                {
                    let _ = pending.response.send(if current {
                        result.into_result()
                    } else {
                        Err(ApiError::unavailable())
                    });
                }
            }
            Envelope::Notify { audience, message } => {
                let routes = self.inner.lock().await;
                for (login, clients) in &routes.clients {
                    for client in clients.values() {
                        if audience.matches(login, &client.user_id)
                            && client.sender.try_send(message.clone()).is_err()
                        {
                            let _ = client.shutdown.send(Some(1012));
                        }
                    }
                }
            }
            Envelope::Revoke { peers, reason } => {
                let routes = self.inner.lock().await;
                for peer in peers {
                    let message = ControlMessage::PeerRevoked {
                        peer_id: peer.peer_id,
                        reason: reason.clone(),
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
            Envelope::Disconnect { audience } => {
                let routes = self.inner.lock().await;
                if let Audience::Machine(machine) = &audience {
                    if let Some(daemon) = routes.daemons.get(machine) {
                        let _ = daemon.shutdown.send(Some(4403));
                    }
                } else {
                    for (login, clients) in &routes.clients {
                        for client in clients.values() {
                            if audience.matches(login, &client.user_id) {
                                let _ = client.shutdown.send(Some(4401));
                            }
                        }
                    }
                }
            }
            Envelope::Replace {
                machine_id,
                connection_id,
            } => {
                self.remove_local_daemon(&machine_id, &connection_id).await;
            }
        }
        Ok(())
    }
    pub(super) async fn remove_local_daemon(&self, machine: &str, connection: &str) -> bool {
        let forwarded = {
            let mut routes = self.inner.lock().await;
            if routes
                .daemons
                .get(machine)
                .is_none_or(|d| d.connection_id != connection)
            {
                return false;
            }
            if let Some(daemon) = routes.daemons.remove(machine) {
                let _ = daemon.shutdown.send(Some(1012));
            }
            let ids: Vec<_> = routes
                .pending
                .iter()
                .filter(|(_, p)| p.machine_id == machine && p.connection_id == connection)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                if let Some(pending) = routes.pending.remove(&id) {
                    let _ = pending.response.send(Err(ApiError::unavailable()));
                }
            }
            let ids: Vec<_> = routes
                .forwarded
                .iter()
                .filter(|(_, p)| p.machine_id == machine && p.connection_id == connection)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| routes.forwarded.remove(&id).map(|p| (id, p)))
                .collect::<Vec<_>>()
        };
        for (id, pending) in forwarded {
            let reply = Envelope::Response {
                id,
                machine_id: machine.into(),
                connection_id: connection.into(),
                result: WireResult::from(Err(ApiError::unavailable())),
            };
            if self.publish(&pending.source, &reply).await.is_err() {
                tracing::warn!("cross-instance disconnect response delivery failed");
            }
        }
        true
    }
    pub(super) async fn fail_local(&self) {
        let mut routes = self.inner.lock().await;
        for (_, daemon) in routes.daemons.drain() {
            let _ = daemon.shutdown.send(Some(1012));
        }
        for (_, clients) in routes.clients.drain() {
            for client in clients.into_values() {
                let _ = client.shutdown.send(Some(1012));
            }
        }
        for (_, pending) in routes.pending.drain() {
            let _ = pending.response.send(Err(ApiError::unavailable()));
        }
        routes.forwarded.clear();
    }
    pub(super) async fn sweep(&self) {
        let now = deskfleet_control_store::now_ms();
        let mut routes = self.inner.lock().await;
        routes.pending.retain(|_, p| !p.response.is_closed());
        routes.forwarded.retain(|_, p| p.expires_at > now);
    }
}
impl Audience {
    fn matches(&self, login: &str, user: &str) -> bool {
        match self {
            Self::Login(id) => id == login,
            Self::Users(ids) => ids.iter().any(|id| id == user),
            Self::Machine(_) => false,
        }
    }
}
