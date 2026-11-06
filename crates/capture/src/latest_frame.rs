//! A capture callback keeps the newest raw frame while encoding is paused.

use std::sync::{Condvar, Mutex};
use std::time::Duration;

use crate::CaptureError;

struct State<T> {
    frame: Option<T>,
    closed: bool,
}

pub(crate) struct LatestFrame<T> {
    state: Mutex<State<T>>,
    ready: Condvar,
}

impl<T> LatestFrame<T> {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(State {
                frame: None,
                closed: false,
            }),
            ready: Condvar::new(),
        }
    }

    pub(crate) fn publish(&self, frame: T) {
        let replaced = if let Ok(mut state) = self.state.lock() {
            if state.closed {
                return;
            }
            let replaced = state.frame.replace(frame);
            self.ready.notify_one();
            replaced
        } else {
            None
        };
        // Release the old GPU surface outside the lock used by the consumer.
        drop(replaced);
    }

    pub(crate) fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            self.ready.notify_all();
        }
    }

    pub(crate) fn receive(&self, timeout: Option<Duration>) -> Result<Option<T>, CaptureError> {
        let state = self.state.lock().map_err(|_| CaptureError::StreamEnded)?;
        let pending = |state: &mut State<T>| state.frame.is_none() && !state.closed;
        let mut state = match timeout {
            Some(timeout) => {
                self.ready
                    .wait_timeout_while(state, timeout, pending)
                    .map_err(|_| CaptureError::StreamEnded)?
                    .0
            }
            None => self
                .ready
                .wait_while(state, pending)
                .map_err(|_| CaptureError::StreamEnded)?,
        };
        if let Some(frame) = state.frame.take() {
            Ok(Some(frame))
        } else if state.closed {
            Err(CaptureError::StreamEnded)
        } else {
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, mpsc};

    #[test]
    fn paused_consumer_gets_final_update_even_after_capture_becomes_idle() {
        let slot = LatestFrame::new();
        for frame in 0..100 {
            slot.publish(frame);
        }
        assert_eq!(slot.receive(Some(Duration::ZERO)).unwrap(), Some(99));
        assert_eq!(slot.receive(Some(Duration::ZERO)).unwrap(), None);
    }

    #[test]
    fn replacing_a_frame_releases_its_surface() {
        let slot = LatestFrame::new();
        let old_surface = Arc::new(());
        slot.publish(Arc::clone(&old_surface));
        assert_eq!(Arc::strong_count(&old_surface), 2);
        slot.publish(Arc::new(()));
        assert_eq!(Arc::strong_count(&old_surface), 1);
    }

    #[test]
    fn close_drains_latest_frame_then_ends_and_rejects_late_callbacks() {
        let slot = LatestFrame::new();
        slot.publish(1);
        slot.close();
        slot.publish(2);
        assert_eq!(slot.receive(None).unwrap(), Some(1));
        assert!(matches!(slot.receive(None), Err(CaptureError::StreamEnded)));
    }

    #[test]
    fn publication_and_close_wake_waiting_consumers() {
        for close in [false, true] {
            let slot = Arc::new(LatestFrame::new());
            let waiting = Arc::clone(&slot);
            let (ready, started) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                ready.send(()).unwrap();
                waiting.receive(Some(Duration::from_secs(1)))
            });
            started.recv().unwrap();
            if close {
                slot.close();
                assert!(matches!(
                    worker.join().unwrap(),
                    Err(CaptureError::StreamEnded)
                ));
            } else {
                slot.publish(42);
                assert_eq!(worker.join().unwrap().unwrap(), Some(42));
            }
        }
    }
}
