#import <Foundation/Foundation.h>
#import <Network/Network.h>

bool deskfleet_network_is_metered(void) {
    @autoreleasepool {
        nw_path_monitor_t monitor = nw_path_monitor_create();
        dispatch_queue_t queue = dispatch_queue_create("deskfleet.network-cost", DISPATCH_QUEUE_SERIAL);
        dispatch_semaphore_t ready = dispatch_semaphore_create(0);
        __block bool metered = false;
        nw_path_monitor_set_queue(monitor, queue);
        nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
            metered = nw_path_is_expensive(path) || nw_path_is_constrained(path);
            dispatch_semaphore_signal(ready);
        });
        nw_path_monitor_start(monitor);
        dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
        // Read on the callback's serial queue. ARC keeps captured state alive
        // until cancellation finishes, including after a snapshot timeout.
        __block bool snapshot = false;
        dispatch_sync(queue, ^{ snapshot = metered; });
        nw_path_monitor_cancel(monitor);
        return snapshot;
    }
}
