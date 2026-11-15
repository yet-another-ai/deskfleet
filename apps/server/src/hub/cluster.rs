//! Ephemeral per-process inboxes. Delivery is not a durable command retry queue.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::{
    task::JoinHandle,
    time::{Instant, MissedTickBehavior},
};

const POLL: Duration = Duration::from_millis(100);
const HEARTBEAT: Duration = Duration::from_secs(5);
const DATABASE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(super) struct Cluster {
    pub(super) store: ControlStore,
    pub(super) id: String,
    healthy: Arc<AtomicBool>,
}
impl Cluster {
    pub(super) fn ready(&self) -> bool {
        self.healthy.load(Ordering::Acquire)
    }
    pub(super) fn ensure_ready(&self) -> Result<()> {
        if self.ready() {
            Ok(())
        } else {
            Err(ApiError::unavailable())
        }
    }
    pub(super) fn mark_unhealthy(&self) {
        self.healthy.store(false, Ordering::Release);
    }
}
pub(crate) struct Router(JoinHandle<()>);
impl Drop for Router {
    fn drop(&mut self) {
        self.0.abort();
    }
}
pub(super) async fn connect(store: ControlStore) -> Result<(Hub, Router)> {
    let id = uuid::Uuid::new_v4().to_string();
    store.register_node(&id).await?;
    let hub = Hub {
        inner: Default::default(),
        registration: Default::default(),
        cluster: Some(Cluster {
            store,
            id,
            healthy: Arc::new(AtomicBool::new(true)),
        }),
    };
    let router = Router(tokio::spawn(run(hub.clone())));
    Ok((hub, router))
}
impl Hub {
    pub(super) async fn publish(&self, node: &str, envelope: &Envelope) -> Result<bool> {
        let cluster = self.cluster.as_ref().ok_or_else(ApiError::internal)?;
        cluster.ensure_ready()?;
        let payload = serde_json::to_value(envelope).map_err(|_| ApiError::internal())?;
        Ok(cluster.store.publish_node(node, &payload).await?)
    }
    pub(super) async fn broadcast(&self, envelope: Envelope) -> Result<()> {
        if let Some(cluster) = &self.cluster {
            cluster.ensure_ready()?;
            let payload = serde_json::to_value(&envelope).map_err(|_| ApiError::internal())?;
            if let Err(error) = cluster.store.broadcast_nodes(&cluster.id, &payload).await {
                cluster.healthy.store(false, Ordering::Release);
                let _registration = self.registration.lock().await;
                self.fail_local().await;
                return Err(error.into());
            }
        }
        self.dispatch(envelope).await
    }
}
// Keep ownership renewal independent of the amount of work in one consumed
// inbox batch. Only an actual database/lease failure invalidates this node;
// an individual delivery failure does not describe the health of its sockets.
async fn run(hub: Hub) {
    let Some(cluster) = &hub.cluster else {
        return;
    };
    loop {
        let result = async {
            if !cluster.ready() {
                let _registration = hub.registration.lock().await;
                // Every socket was fenced before recovery. Clear the old routes
                // and inbox before accepting registrations for the renewed node.
                database("release_node", cluster.store.release_node(&cluster.id)).await?;
                database("register_node", cluster.store.register_node(&cluster.id)).await?;
                cluster.healthy.store(true, Ordering::Release);
            }
            with_heartbeat(deliver(&hub), HEARTBEAT, || renew(&hub)).await
        }
        .await;
        if let Err(error) = result {
            if cluster.healthy.swap(false, Ordering::AcqRel) {
                tracing::warn!(
                    code = %error.code,
                    "realtime database routing unavailable; closing local sockets before reconnecting"
                );
            }
            {
                let _registration = hub.registration.lock().await;
                hub.fail_local().await;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

async fn database<T>(
    operation: &'static str,
    future: impl std::future::Future<Output = deskfleet_control_store::Result<T>>,
) -> Result<T> {
    tokio::time::timeout(DATABASE_TIMEOUT, future)
        .await
        .map_err(|_| {
            tracing::warn!(operation, "realtime database operation timed out");
            ApiError::internal()
        })?
        .map_err(ApiError::from)
}

async fn renew(hub: &Hub) -> Result<()> {
    let cluster = hub.cluster.as_ref().ok_or_else(ApiError::internal)?;
    cluster.ensure_ready()?;
    // An uninterrupted renewal changes only the node lease, so it must not wait
    // behind request delivery's registration gate. If the lease did expire,
    // fence immediately; run() cancels delivery before taking that gate and
    // closing old sockets, then recovery clears any concurrently claimed route.
    if !database("heartbeat_node", cluster.store.heartbeat_node(&cluster.id)).await? {
        return Err(ApiError::unavailable());
    }
    hub.sweep().await;
    Ok(())
}

async fn deliver(hub: &Hub) -> Result<()> {
    let cluster = hub.cluster.as_ref().ok_or_else(ApiError::internal)?;
    let mut interval = tokio::time::interval(POLL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        cluster.ensure_ready()?;
        let messages = database(
            "take_node_messages",
            cluster.store.take_node_messages(&cluster.id, 128),
        )
        .await?;
        for message in messages {
            // The inbox is at-most-once. Isolate a bad/expired recipient or an
            // undeliverable response; callers retain their existing deadlines
            // and operation receipts rather than retrying consumed commands.
            let envelope = match serde_json::from_value(message) {
                Ok(envelope) => envelope,
                Err(_) => {
                    tracing::warn!("invalid realtime inbox envelope discarded");
                    continue;
                }
            };
            // Delivery owns its individual sink deadlines and their cleanup.
            // An outer timeout could cancel a stalled-client revocation just
            // before it closes that socket, silently losing the control event.
            if let Err(error) = hub.dispatch(envelope).await {
                tracing::warn!(code = %error.code, "realtime inbox delivery failed");
            }
            tokio::task::yield_now().await;
        }
    }
}

/// Keep both futures alive across heartbeats: renewing a lease must not cancel
/// an envelope already removed from PostgreSQL or pause its delivery deadline.
async fn with_heartbeat<W, F, R>(work: W, heartbeat: Duration, mut renew: F) -> Result<()>
where
    W: std::future::Future<Output = Result<()>>,
    F: FnMut() -> R,
    R: std::future::Future<Output = Result<()>>,
{
    let keep_alive = async {
        let mut interval = tokio::time::interval_at(Instant::now() + heartbeat, heartbeat);
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            renew().await?;
        }
    };
    tokio::select! {
        result = work => result,
        result = keep_alive => result,
    }
}

#[cfg(test)]
#[path = "cluster_tests.rs"]
mod tests;
