//! Replayable aggregate polling, independently leased from coturn's Redis stream.
use super::client::Client;
use deskfleet_control_store::{ControlStore, now_ms};
use std::time::Duration;
use tokio::{task::JoinHandle, time};

pub(super) struct Collector(JoinHandle<()>);

impl Collector {
    pub(super) fn start(store: ControlStore, client: Client) -> Self {
        Self(tokio::spawn(run(store, client)))
    }
}

impl Drop for Collector {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn run(store: ControlStore, client: Client) {
    let owner = uuid::Uuid::new_v4().to_string();
    loop {
        if !matches!(
            store.claim_cloudflare_turn_collector(&owner).await,
            Ok(true)
        ) {
            time::sleep(Duration::from_secs(15)).await;
            continue;
        }
        match collect_one(&store, &client, &owner).await {
            Ok(true) => {
                // Cloudflare's default GraphQL limit is 300 queries / 5 minutes.
                // A single leased worker keeps polling below that rate across replicas.
                time::sleep(Duration::from_millis(1_250)).await;
            }
            Ok(false) => time::sleep(Duration::from_secs(15)).await,
            Err(_) => {
                // Provider error text may contain secrets; only emit a stable message.
                tracing::warn!("Cloudflare TURN usage collection failed; retrying");
                let _ = store.cloudflare_turn_collector_gap(&owner).await;
                time::sleep(Duration::from_secs(15)).await;
            }
        }
    }
}

async fn collect_one(
    store: &ControlStore,
    client: &Client,
    owner: &str,
) -> crate::error::Result<bool> {
    let Some(query) = store
        .cloudflare_turn_usage_queries(now_ms(), 1)
        .await?
        .into_iter()
        .next()
    else {
        return Ok(false);
    };
    let result = client
        .usage(
            &query.account_id,
            &query.key_id,
            &query.analytics_token,
            &query.identifier,
            query.period_start,
            query.query_end,
        )
        .await;
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(error) => {
            // A broken or retired key must not monopolize the oldest-due slot.
            // Failure postpones this source without marking its usage fresh.
            if store.fail_cloudflare_turn_usage(&query, owner).await? {
                tracing::warn!("Cloudflare TURN analytics request failed; source will retry");
                return Ok(true);
            }
            return Err(error);
        }
    };
    if !store
        .save_cloudflare_turn_usage(&query, bytes, owner)
        .await?
    {
        return Ok(false);
    }
    store.heartbeat_cloudflare_turn_collector(owner).await?;
    Ok(true)
}
