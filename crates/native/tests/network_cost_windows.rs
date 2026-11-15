#![cfg(windows)]

use deskfleet_native::network_cost::is_network_metered;
use std::sync::atomic::{AtomicBool, Ordering};

// Keep this in its own test binary so other native tests cannot leave an MTA
// alive and hide a factory-cache lifetime error in the network-cost query.
#[test]
fn network_cost_queries_survive_worker_shutdown() {
    // The public API maps JoinError to unknown cost. A worker panic must still
    // fail this lifetime regression instead of looking like an ordinary OS error.
    static PANICKED: AtomicBool = AtomicBool::new(false);
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| PANICKED.store(true, Ordering::Relaxed)));
    for _ in 0..3 {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("create network-cost test runtime");
        for _ in 0..3 {
            // The runner's actual cost may be unknown. The regression is a native
            // access violation when a subsequent query reuses an unloaded factory.
            std::hint::black_box(runtime.block_on(is_network_metered()));
        }
        // Dropping the runtime terminates its blocking workers before the next run.
    }
    std::panic::set_hook(previous_hook);
    assert!(
        !PANICKED.load(Ordering::Relaxed),
        "network-cost worker panicked"
    );
}
