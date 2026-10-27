//! Best-effort coturn Pub/Sub collection, owned by the central server process.
mod message;

use std::{io, time::Duration};

use deskfleet_control_store::ControlStore;
use futures_util::StreamExt;
use redis::{Client, aio::PubSub};
use tokio::{task::JoinHandle, time};

const RETRY_DELAY: Duration = Duration::from_secs(1);
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);
const PATTERNS: [&str; 4] = [
    "turn/realm/*/user/*/allocation/*/traffic",
    "turn/realm/*/user/*/allocation/*/traffic/peer",
    "turn/user/*/allocation/*/traffic",
    "turn/user/*/allocation/*/traffic/peer",
];

pub(super) struct Collector(JoinHandle<()>);

impl Collector {
    pub(super) fn start(store: ControlStore, url: &str) -> io::Result<Self> {
        let client = Client::open(url).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid DESKFLEET_TURN_USAGE_REDIS_URL",
            )
        })?;
        Ok(Self(tokio::spawn(run(store, client))))
    }
}

impl Drop for Collector {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn subscribe(client: &Client) -> io::Result<PubSub> {
    time::timeout(CONNECTION_TIMEOUT, async {
        let mut pubsub = client.get_async_pubsub().await?;
        pubsub.psubscribe(&PATTERNS).await?;
        Ok::<_, redis::RedisError>(pubsub)
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "TURN usage subscription timed out"))?
    // Do not include connection errors that could contain Redis credentials.
    .map_err(|_| io::Error::other("TURN usage Redis subscription failed"))
}

async fn run(store: ControlStore, client: Client) {
    let owner = uuid::Uuid::new_v4().to_string();
    loop {
        if !matches!(store.claim_turn_collector(&owner).await, Ok(true)) {
            time::sleep(Duration::from_secs(15)).await;
            continue;
        }
        match subscribe(&client).await {
            Ok(pubsub) => {
                tracing::info!("TURN usage collector subscribed");
                collect(&store, pubsub, &owner).await;
            }
            Err(error) => {
                tracing::warn!(%error, "TURN usage subscription failed; retrying");
            }
        }
        let _ = store.turn_collector_gap(&owner).await;
        time::sleep(RETRY_DELAY).await;
    }
}

async fn collect(store: &ControlStore, pubsub: PubSub, owner: &str) {
    let (mut sink, mut messages) = pubsub.split();
    let mut heartbeat = time::interval(Duration::from_secs(15));
    heartbeat.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
    loop {
        let message = tokio::select! {
            message = messages.next() => match message {
                Some(message) => message,
                None => {
                    tracing::warn!("TURN usage subscription ended; reconnecting");
                    return;
                }
            },
            _ = heartbeat.tick() => {
                if !matches!(time::timeout(CONNECTION_TIMEOUT, sink.ping::<redis::Value>()).await, Ok(Ok(_))) {
                    tracing::warn!("TURN usage Redis heartbeat failed; reconnecting");
                    return;
                }
                if !matches!(store.heartbeat_turn_collector(owner).await, Ok(true)) {
                    return;
                }
                continue;
            }
        };
        let Ok(payload) = message.get_payload::<String>() else {
            tracing::warn!("discarding invalid TURN usage payload");
            continue;
        };
        let usage = match message::parse_usage(message.get_channel_name(), &payload) {
            Ok(Some(usage)) => usage,
            Ok(None) => continue,
            Err(_) => {
                tracing::warn!("discarding malformed TURN usage event");
                continue;
            }
        };
        if store
            .record_turn_usage_owned(&usage, Some(owner))
            .await
            .is_err()
        {
            tracing::warn!("TURN usage write failed; discarding event and reconnecting");
            return;
        }
    }
}

#[cfg(test)]
mod tests;
