//! Incoming clipboard delivery belongs to one native session, peer, and mount.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// A cancelled ticket is never rearmed, even if its owner starts another peer.
#[derive(Clone, Default)]
struct Ticket(Arc<AtomicBool>);

impl Ticket {
    fn live() -> Self {
        Self(Arc::new(AtomicBool::new(true)))
    }

    fn active(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    fn cancel(&self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Default)]
struct State {
    closed: bool,
    mounted: bool,
    peer: Ticket,
    revision: Ticket,
}

impl State {
    fn mount(&mut self) -> bool {
        if self.closed {
            return false;
        }
        self.mounted = true;
        self.reset();
        true
    }

    fn reset(&mut self) {
        self.revision.cancel();
        if self.mounted && !self.closed {
            self.revision = Ticket::live();
        }
    }

    fn unmount(&mut self) {
        self.mounted = false;
        self.revision.cancel();
    }

    fn start_peer(&mut self) {
        self.peer.cancel();
        if !self.closed {
            self.peer = Ticket::live();
        }
    }

    fn close(&mut self) {
        self.closed = true;
        self.peer.cancel();
        self.unmount();
    }
}

/// Stored by ActiveSession and captured once by each VideoView at creation.
#[derive(Clone, Default)]
pub(crate) struct Target {
    state: Arc<Mutex<State>>,
}

impl Target {
    /// Pin a receiver to this Start before it enters the runtime queue. A later
    /// Stop or Start cancels this receiver without changing its ticket identity.
    pub(crate) fn start_peer(&self) -> Receiver {
        let mut state = self.state.lock().expect("clipboard target lock poisoned");
        state.start_peer();
        Receiver {
            target: self.clone(),
            peer: state.peer.clone(),
        }
    }

    pub(crate) fn stop_peer(&self) {
        self.state
            .lock()
            .expect("clipboard target lock poisoned")
            .peer
            .cancel();
    }

    /// Permanently close this native session before joining either worker.
    pub(crate) fn close(&self) {
        self.state
            .lock()
            .expect("clipboard target lock poisoned")
            .close();
    }
}

/// Held for exactly one run_peer invocation, including negotiation and errors.
pub(crate) struct Receiver {
    target: Target,
    peer: Ticket,
}

impl std::fmt::Debug for Receiver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Receiver").finish_non_exhaustive()
    }
}

impl Receiver {
    fn delivery(&self) -> Option<Delivery> {
        if !self.peer.active() {
            return None;
        }
        let state = self
            .target
            .state
            .lock()
            .expect("clipboard target lock poisoned");
        if !state.mounted || state.closed {
            return None;
        }
        Some(Delivery {
            target: self.target.clone(),
            peer: self.peer.clone(),
            revision: state.revision.clone(),
        })
    }

    /// Cancel before async teardown, while Drop also covers future cancellation.
    pub(crate) fn stop(&self) {
        self.peer.cancel();
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Captured at receipt, before dispatch. No UIKit references leave main.
struct Delivery {
    target: Target,
    peer: Ticket,
    revision: Ticket,
}

impl Delivery {
    fn active(&self) -> bool {
        self.peer.active() && self.revision.active()
    }
}

#[cfg(target_os = "ios")]
mod platform {
    use std::cell::RefCell;

    use dispatch2::DispatchQueue;
    use objc2::MainThreadMarker;
    use objc2::rc::Weak;

    use super::*;
    use crate::ios_window::VideoView;

    // The mobile bridge mounts one controller at a time. Identity checks keep
    // queued work and late teardown from following a replacement controller.
    thread_local! {
        static MOUNTED: RefCell<Option<Mounted>> = const { RefCell::new(None) };
    }

    struct Mounted {
        target: std::sync::Weak<Mutex<State>>,
        view: Weak<VideoView>,
    }

    impl Mounted {
        fn is_target(&self, target: &Target) -> bool {
            self.target.ptr_eq(&Arc::downgrade(&target.state))
        }

        fn is_view(&self, target: &Target, view: &VideoView) -> bool {
            self.is_target(target)
                && self
                    .view
                    .load()
                    .is_some_and(|mounted| std::ptr::eq(&*mounted, view))
        }
    }

    impl Target {
        /// Replace the mounted view and cancel work queued for its predecessor.
        pub(crate) fn mount(&self, view: &VideoView) {
            if !self
                .state
                .lock()
                .expect("clipboard target lock poisoned")
                .mount()
            {
                return;
            }
            let previous = MOUNTED.with(|slot| {
                slot.replace(Some(Mounted {
                    target: Arc::downgrade(&self.state),
                    view: Weak::new(view),
                }))
            });
            if let Some(previous) = previous
                && !previous.is_target(self)
                && let Some(state) = previous.target.upgrade()
            {
                state
                    .lock()
                    .expect("clipboard target lock poisoned")
                    .unmount();
            }
        }

        /// Call before resetting this view's clipboard policy. Later messages
        /// from the same live peer remain eligible; queued writes are cancelled.
        pub(crate) fn reset(&self, view: &VideoView) {
            let matches = MOUNTED.with(|slot| {
                slot.borrow()
                    .as_ref()
                    .is_some_and(|mounted| mounted.is_view(self, view))
            });
            if matches {
                self.state
                    .lock()
                    .expect("clipboard target lock poisoned")
                    .reset();
            }
        }

        /// Late teardown of an old controller cannot unmount its replacement.
        pub(crate) fn unmount(&self, view: &VideoView) {
            let removed = MOUNTED.with(|slot| {
                let mut slot = slot.borrow_mut();
                if slot
                    .as_ref()
                    .is_some_and(|mounted| mounted.is_view(self, view))
                {
                    slot.take()
                } else {
                    None
                }
            });
            if removed.is_some() {
                self.state
                    .lock()
                    .expect("clipboard target lock poisoned")
                    .unmount();
            }
        }
    }

    impl Receiver {
        pub(crate) fn receive(&self, text: &str) {
            let Some(delivery) = self.delivery() else {
                return;
            };
            let text = text.to_owned();
            DispatchQueue::main().exec_async(move || {
                let _mtm = MainThreadMarker::new().expect("main dispatch queue");
                if !delivery.active() {
                    return;
                }
                let view = MOUNTED.with(|slot| {
                    let slot = slot.borrow();
                    let mounted = slot.as_ref()?;
                    mounted
                        .is_target(&delivery.target)
                        .then(|| mounted.view.load())
                        .flatten()
                });
                if let Some(view) = view {
                    // The view rechecks current input/sharing/stopped policy.
                    // Neither a mutex nor the lookup borrow spans UIKit calls.
                    view.receive_clipboard(&text);
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mounted() -> Target {
        let target = Target::default();
        assert!(target.state.lock().unwrap().mount());
        target
    }

    #[test]
    fn delayed_start_after_stop_cannot_rearm_the_peer() {
        let target = mounted();
        let old = target.start_peer();
        target.stop_peer();
        assert!(old.delivery().is_none());

        let next = target.start_peer();
        drop(old);
        assert!(next.delivery().unwrap().active());
    }

    #[test]
    fn queued_start_stop_start_keeps_each_commands_own_receiver() {
        let target = mounted();
        let mut queued = std::collections::VecDeque::new();
        queued.push_back(Some(target.start_peer()));
        target.stop_peer();
        queued.push_back(None); // Stop follows A, before B, in the command queue.
        queued.push_back(Some(target.start_peer()));

        // Runtime starts processing A only after all three were submitted.
        let a = queued.pop_front().unwrap().unwrap();
        assert!(a.delivery().is_none());
        drop(a);
        assert!(queued.pop_front().unwrap().is_none());
        let b = queued.pop_front().unwrap().unwrap();
        assert!(b.delivery().unwrap().active());
    }

    #[test]
    fn reset_cancels_queued_delivery_but_keeps_the_peer() {
        let target = mounted();
        let receiver = target.start_peer();
        let queued = receiver.delivery().unwrap();
        target.state.lock().unwrap().reset();
        assert!(!queued.active());
        assert!(receiver.delivery().unwrap().active());
    }

    #[test]
    fn stop_and_receiver_drop_cancel_queued_delivery() {
        let target = mounted();
        let receiver = target.start_peer();
        let queued = receiver.delivery().unwrap();
        target.stop_peer();
        assert!(!queued.active());

        let next = target.start_peer();
        let queued = next.delivery().unwrap();
        drop(next);
        assert!(!queued.active());
    }

    #[test]
    fn close_is_permanent_and_old_receiver_cannot_cancel_new_peer() {
        let target = mounted();
        let old = target.start_peer();
        let next = target.start_peer();
        assert!(old.delivery().is_none());
        drop(old);
        let queued = next.delivery().unwrap();
        assert!(queued.active());

        target.close();
        assert!(!queued.active());
        let closed = target.start_peer();
        assert!(!target.state.lock().unwrap().mount());
        assert!(closed.delivery().is_none());
    }

    #[test]
    fn mounts_do_not_replay_earlier_messages() {
        let target = Target::default();
        let receiver = target.start_peer();
        assert!(receiver.delivery().is_none());
        assert!(target.state.lock().unwrap().mount());
        let queued = receiver.delivery().unwrap();
        assert!(Arc::ptr_eq(&queued.target.state, &target.state));

        assert!(target.state.lock().unwrap().mount());
        assert!(!queued.active());
        let replacement = receiver.delivery().unwrap();
        target.state.lock().unwrap().unmount();
        assert!(!replacement.active());
        assert!(receiver.delivery().is_none());
    }
}
