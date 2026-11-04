use deskfleet_control_store::{ControlStore, Error, Result};
use std::{future::Future, time::Duration};
use tokio::{
    task::JoinHandle,
    time::{Instant, MissedTickBehavior, timeout_at},
};

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
                run_pass(
                    Instant::now() + Duration::from_secs(20),
                    store.claim_expiry_maintenance(),
                    store.prune_auth_records(1000),
                    store.prune_realtime(),
                    store.compact_turn_usage(10_000),
                )
                .await;
            }
        }))
    }
}

async fn run_pass(
    deadline: Instant,
    claim: impl Future<Output = Result<bool>>,
    auth: impl Future<Output = Result<u64>>,
    realtime: impl Future<Output = Result<()>>,
    turn_usage: impl Future<Output = Result<u64>>,
) {
    if run_step("claim", deadline, claim).await != Some(true) {
        return;
    }
    // An error or stalled query in one category must not starve the others.
    // Share the original pass deadline so cleanup stays within the 30-second lease.
    tokio::join!(
        run_step("auth", deadline, auth),
        run_step("realtime", deadline, realtime),
        run_step("turn_usage", deadline, turn_usage),
    );
}

async fn run_step<T>(
    step: &'static str,
    deadline: Instant,
    work: impl Future<Output = Result<T>>,
) -> Option<T> {
    match timeout_at(deadline, work).await {
        Ok(Ok(value)) => Some(value),
        Ok(Err(error)) => {
            let span = tracing::warn_span!("expiry_maintenance", step);
            let _entered = span.enter();
            // Reuse storage diagnostics that omit query parameters and row contents.
            match &error {
                Error::Database(error) => crate::error::log_database_error(error),
                Error::Json(error) => crate::error::log_json_error(error),
                _ => {}
            }
            tracing::warn!(
                error = %error,
                "expiry maintenance step failed; remaining records will retry next pass"
            );
            None
        }
        Err(_) => {
            tracing::warn!(
                step,
                "expiry maintenance step timed out; remaining records will retry next pass"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests;
