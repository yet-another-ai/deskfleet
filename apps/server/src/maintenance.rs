use deskfleet_control_store::ControlStore;
use std::time::Duration;
use tokio::{task::JoinHandle, time::MissedTickBehavior};

pub(crate) struct Maintenance(JoinHandle<()>);
impl Drop for Maintenance {
    fn drop(&mut self) {
        self.0.abort();
    }
}
impl Maintenance {
    pub(crate) fn start(store: ControlStore) -> Self {
        Self(tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                let pass = async {
                    if store.claim_expiry_maintenance().await? {
                        store.prune_auth_records(1000).await?;
                        store.prune_realtime().await?;
                    }
                    Ok::<_, deskfleet_control_store::Error>(())
                };
                if !matches!(
                    tokio::time::timeout(Duration::from_secs(20), pass).await,
                    Ok(Ok(()))
                ) {
                    tracing::warn!(
                        "expiry maintenance failed; remaining records will retry next pass"
                    );
                }
            }
        }))
    }
}
