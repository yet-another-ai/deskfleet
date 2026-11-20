use super::*;

impl Hub {
    pub(super) async fn send_request(
        &self,
        machine: &str,
        connection: &str,
        message: ControlMessage,
    ) -> Result<()> {
        let _registration = self.registration.lock().await;
        self.send_current(machine, connection, message, None).await
    }

    #[tracing::instrument(skip_all, fields(registration_id = machine))]
    pub(crate) async fn reconcile_daemon(&self, machine: &str, connection: &str) -> Result<()> {
        // A peer offer must not overtake a snapshot that predates its grant.
        // The same gate also fences local connection replacement and routing recovery.
        let _registration = self.registration.lock().await;
        let cluster = self.cluster.as_ref().ok_or_else(ApiError::internal)?;
        cluster.ensure_ready()?;
        let peers = cluster.store.valid_machine_peers(machine).await?;
        self.send_current(
            machine,
            connection,
            ControlMessage::ReconcilePeers { peers },
            None,
        )
        .await
    }

    /// Caller holds registration through the database check and queue insertion.
    async fn send_current(
        &self,
        machine: &str,
        connection: &str,
        message: ControlMessage,
        expires_at: Option<i64>,
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
        // A ready gated future can win the timeout poll after its deadline.
        // Check consumed envelopes again immediately before queue insertion.
        if expires_at.is_some_and(|expiry| expiry <= deskfleet_control_store::now_ms()) {
            return Err(timeout_error());
        }
        daemon
            .sender
            .try_send(message)
            .map_err(|error| match error {
                outbox::SendError::Full => ApiError::busy(),
                outbox::SendError::Closed => ApiError::unavailable(),
            })
    }
    pub(super) async fn dispatch(&self, envelope: Envelope) -> Result<()> {
        match envelope {
            Envelope::Request {
                source,
                registration_id,
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
                        registration_id: registration_id.clone(),
                        connection_id: connection_id.clone(),
                        expires_at,
                    },
                );
                // Expiry also bounds waiting for the registration gate and
                // route validation. Cancelling a consumed request must retire
                // its forwarding entry, without fencing a healthy machine.
                let remaining =
                    u64::try_from(expires_at.saturating_sub(deskfleet_control_store::now_ms()))
                        .unwrap_or_default();
                let delivered = if remaining == 0 {
                    Err(timeout_error())
                } else {
                    tokio::time::timeout(Duration::from_millis(remaining), async {
                        let _registration = self.registration.lock().await;
                        self.send_current(
                            &registration_id,
                            &connection_id,
                            message,
                            Some(expires_at),
                        )
                        .await
                    })
                    .await
                    .unwrap_or_else(|_| Err(timeout_error()))
                };
                if let Err(error) = delivered {
                    // Socket retirement can already own the reply.
                    let forwarded = self.inner.lock().await.forwarded.remove(&id);
                    if forwarded.is_some() {
                        self.publish(
                            &source,
                            &Envelope::Response {
                                id,
                                registration_id,
                                connection_id,
                                result: WireResult::from(Err(error)),
                            },
                        )
                        .await?;
                    }
                }
            }
            Envelope::Response {
                id,
                registration_id,
                connection_id,
                result,
            } => {
                let current = self
                    .route(&registration_id)
                    .await?
                    .is_some_and(|r| r.connection_id == connection_id);
                let mut routes = self.inner.lock().await;
                if routes.pending.get(&id).is_some_and(|p| {
                    p.registration_id == registration_id && p.connection_id == connection_id
                }) && let Some(pending) = routes.pending.remove(&id)
                {
                    let _ = pending.response.send(if current {
                        result.into_result()
                    } else {
                        Err(ApiError::unavailable())
                    });
                }
            }
            Envelope::Notify { audience, message } => {
                let deliveries = {
                    let routes = self.inner.lock().await;
                    routes
                        .clients
                        .iter()
                        .flat_map(|(login, clients)| {
                            clients
                                .values()
                                .filter(|client| audience.matches(login, &client.user_id))
                                .map(|client| (client.sender.clone(), client.shutdown.clone()))
                        })
                        .collect::<Vec<_>>()
                };
                // Hints coalesce immediately. A critical event may wait for its
                // own socket, without holding routes or stalling other viewers.
                futures_util::future::join_all(
                    deliveries.into_iter().map(|(sender, shutdown)| {
                        deliver_client(sender, shutdown, message.clone())
                    }),
                )
                .await;
            }
            Envelope::Revoke { peers, reason } => {
                let deliveries = {
                    let routes = self.inner.lock().await;
                    let mut deliveries = Vec::new();
                    for peer in peers {
                        let message = ControlMessage::PeerRevoked {
                            peer_id: peer.peer_id,
                            reason: reason.clone(),
                        };
                        if let Some(daemon) = routes.daemons.values().find(|daemon| {
                            daemon.team_id == peer.team_id
                                && daemon.public_machine_id == peer.target_machine.id
                        }) && daemon.sender.try_send(message.clone())
                            == Err(outbox::SendError::Full)
                        {
                            // Revocation is already durable. Fetch a fresh grant
                            // snapshot through the ordered registration gate;
                            // unrelated active peers and the Machine stay live.
                            daemon.sender.request_reconciliation();
                        }
                        for clients in routes.clients.values() {
                            for client in clients.values() {
                                if client.user_id == peer.actor.user_id {
                                    deliveries.push((
                                        client.sender.clone(),
                                        client.shutdown.clone(),
                                        message.clone(),
                                    ));
                                }
                            }
                        }
                    }
                    deliveries
                };
                futures_util::future::join_all(
                    deliveries.into_iter().map(|(sender, shutdown, message)| {
                        deliver_client(sender, shutdown, message)
                    }),
                )
                .await;
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
                registration_id,
                connection_id,
            } => {
                self.remove_local_daemon(&registration_id, &connection_id)
                    .await;
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
            let daemon = routes
                .daemons
                .remove(machine)
                .expect("current daemon was checked under the routes lock");
            routes.retire_daemon(machine, daemon)
        };
        self.fail_forwarded_requests(forwarded).await;
        true
    }
    pub(super) async fn fail_forwarded_requests(&self, forwarded: Vec<(String, Forwarded)>) {
        for (id, pending) in forwarded {
            let reply = Envelope::Response {
                id,
                registration_id: pending.registration_id,
                connection_id: pending.connection_id,
                result: WireResult::from(Err(ApiError::unavailable())),
            };
            if self.publish(&pending.source, &reply).await.is_err() {
                tracing::warn!("cross-instance disconnect response delivery failed");
            }
        }
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

impl Routes {
    pub(super) fn retire_daemon(
        &mut self,
        registration_id: &str,
        daemon: Daemon,
    ) -> Vec<(String, Forwarded)> {
        let _ = daemon.shutdown.send(Some(1012));
        for (_, pending) in self.pending.extract_if(|_, request| {
            request.registration_id == registration_id
                && request.connection_id == daemon.connection_id
        }) {
            let _ = pending.response.send(Err(ApiError::unavailable()));
        }
        self.forwarded
            .extract_if(|_, request| {
                request.registration_id == registration_id
                    && request.connection_id == daemon.connection_id
            })
            .collect()
    }
}

async fn deliver_client(
    sender: Sender,
    shutdown: watch::Sender<Option<u16>>,
    message: ControlMessage,
) {
    if tokio::time::timeout(Duration::from_secs(30), sender.send(message))
        .await
        .is_err()
    {
        // Only a critical sink that remains stalled loses its own signaling
        // socket. Refresh traffic has a separate, coalescing budget.
        tracing::warn!("client control delivery stalled");
        let _ = shutdown.send(Some(1012));
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
