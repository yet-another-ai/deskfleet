use super::*;
use std::{cell::Cell, future::pending};

#[tokio::test]
async fn failed_auth_cleanup_does_not_skip_realtime_or_turn_usage() {
    let realtime_ran = Cell::new(false);
    let turn_usage_ran = Cell::new(false);

    run_pass(
        Instant::now() + Duration::from_secs(1),
        async { Ok(true) },
        async { Err(Error::Conflict("peer cleanup failed")) },
        async {
            realtime_ran.set(true);
            Ok(())
        },
        async {
            turn_usage_ran.set(true);
            Ok(1)
        },
    )
    .await;

    assert!(realtime_ran.get());
    assert!(turn_usage_ran.get());
}

#[tokio::test]
async fn stalled_cleanup_is_cancelled_without_blocking_other_categories() {
    struct MarkDropped<'a>(&'a Cell<bool>);
    impl Drop for MarkDropped<'_> {
        fn drop(&mut self) {
            self.0.set(true);
        }
    }

    let auth_cancelled = Cell::new(false);
    let realtime_ran = Cell::new(false);
    let turn_usage_ran = Cell::new(false);
    let pass = run_pass(
        Instant::now() + Duration::from_millis(10),
        async { Ok(true) },
        async {
            let _dropped = MarkDropped(&auth_cancelled);
            pending().await
        },
        async {
            assert!(
                !auth_cancelled.get(),
                "realtime cleanup must start before the stalled auth step times out"
            );
            realtime_ran.set(true);
            Ok(())
        },
        async {
            assert!(
                !auth_cancelled.get(),
                "TURN cleanup must start before the stalled auth step times out"
            );
            turn_usage_ran.set(true);
            Ok(1)
        },
    );

    tokio::time::timeout(Duration::from_secs(1), pass)
        .await
        .expect("the maintenance pass must end at its deadline");

    assert!(auth_cancelled.get());
    assert!(realtime_ran.get());
    assert!(turn_usage_ran.get());
}

#[tokio::test]
async fn an_unclaimed_or_failed_lease_never_starts_cleanup() {
    for claim in [Ok(false), Err(Error::Conflict("lease claim failed"))] {
        run_pass(
            Instant::now() + Duration::from_secs(1),
            async { claim },
            async { panic!("auth cleanup requires the lease") },
            async { panic!("realtime cleanup requires the lease") },
            async { panic!("TURN cleanup requires the lease") },
        )
        .await;
    }
}

#[tokio::test]
async fn a_stalled_lease_claim_never_starts_cleanup() {
    tokio::time::timeout(
        Duration::from_secs(1),
        run_pass(
            Instant::now() + Duration::from_millis(10),
            pending(),
            async { panic!("auth cleanup requires the lease") },
            async { panic!("realtime cleanup requires the lease") },
            async { panic!("TURN cleanup requires the lease") },
        ),
    )
    .await
    .expect("a stalled lease claim must respect the pass deadline");
}
