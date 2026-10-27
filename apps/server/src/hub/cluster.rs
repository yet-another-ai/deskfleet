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
async fn run(hub: Hub) {
    let Some(cluster) = &hub.cluster else {
        return;
    };
    let mut interval = tokio::time::interval(POLL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut heartbeat = Instant::now();
    let mut pruning = Instant::now();
    loop {
        interval.tick().await;
        let step = async {
            if !cluster.ready() {
                let _registration = hub.registration.lock().await;
                // Every socket was closed on loss of the shared control channel.
                // Clear its old routes/inbox before accepting new registrations.
                cluster.store.release_node(&cluster.id).await?;
                cluster.store.register_node(&cluster.id).await?;
                cluster.healthy.store(true, Ordering::Release);
                heartbeat = Instant::now();
            }
            if heartbeat.elapsed() >= HEARTBEAT {
                let _registration = hub.registration.lock().await;
                if !cluster.store.heartbeat_node(&cluster.id).await? {
                    hub.fail_local().await;
                }
                heartbeat = Instant::now();
                hub.sweep().await;
            }
            let messages = cluster.store.take_node_messages(&cluster.id, 128).await?;
            for message in messages {
                let envelope = serde_json::from_value(message).map_err(|_| ApiError::internal())?;
                hub.dispatch(envelope).await?;
            }
            if pruning.elapsed() >= Duration::from_secs(30) {
                cluster.store.prune_realtime().await?;
                pruning = Instant::now();
            }
            Ok::<_, ApiError>(())
        };
        if !matches!(
            tokio::time::timeout(DATABASE_TIMEOUT, step).await,
            Ok(Ok(()))
        ) {
            if cluster.healthy.swap(false, Ordering::AcqRel) {
                tracing::warn!(
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
