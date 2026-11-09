//! Bounded window-to-session input. A slow consumer must not close the video or
//! strand held keys/buttons when pending input has to be discarded.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use deskfleet_input::InputEvent;
use tokio::sync::mpsc;

use crate::Error;

const CAPACITY: usize = 256;
type Pending = Arc<Mutex<VecDeque<InputEvent>>>;

#[derive(Clone)]
pub(crate) struct Sender {
    pending: Pending,
    ready: mpsc::Sender<()>,
}

pub(crate) struct Receiver {
    pending: Pending,
    ready: mpsc::Receiver<()>,
}

pub(crate) fn channel() -> (Sender, Receiver) {
    let pending = Arc::new(Mutex::new(VecDeque::new()));
    // Only wakeups use mpsc; one outstanding notification covers all pending
    // events and preserves cancellation-safe wakeup and sender-drop semantics.
    let (ready, receiver) = mpsc::channel(1);
    (
        Sender {
            pending: Arc::clone(&pending),
            ready,
        },
        Receiver {
            pending,
            ready: receiver,
        },
    )
}

impl Sender {
    pub(crate) fn send(&self, event: InputEvent) -> Result<(), Error> {
        {
            let mut pending = self.pending.lock().map_err(|_| "input queue poisoned")?;
            if matches!(event, InputEvent::ReleaseAll) {
                pending.clear();
            } else if matches!(event, InputEvent::PointerMove { .. })
                && matches!(pending.back(), Some(InputEvent::PointerMove { .. }))
            {
                // Never move pointer updates across a key, button, or wheel.
                pending.pop_back();
            } else if pending.len() == CAPACITY {
                // The ordered channel delivers any in-flight event first.
                // Clear stale presses before releasing remote held state; do
                // not replay the overflowing action without its prior context.
                pending.clear();
                pending.push_back(InputEvent::ReleaseAll);
                tracing::debug!("native input backlog reset");
                return self.wake();
            }
            pending.push_back(event);
        }
        self.wake()
    }

    fn wake(&self) -> Result<(), Error> {
        match self.ready.try_send(()) {
            Ok(()) | Err(mpsc::error::TrySendError::Full(())) => Ok(()),
            Err(mpsc::error::TrySendError::Closed(())) => {
                Err("native input receiver closed".into())
            }
        }
    }
}

impl Receiver {
    pub(crate) async fn recv(&mut self) -> Result<Option<InputEvent>, Error> {
        loop {
            let event = self
                .pending
                .lock()
                .map_err(|_| "input queue poisoned")?
                .pop_front();
            if event.is_some() {
                return Ok(event);
            }
            if self.ready.recv().await.is_none() {
                return Ok(None);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn position(x: f64) -> InputEvent {
        InputEvent::PointerMove { x, y: 0.5 }
    }

    fn key(code: &str) -> InputEvent {
        InputEvent::Key {
            code: code.into(),
            pressed: true,
            repeat: false,
        }
    }

    fn button() -> InputEvent {
        InputEvent::PointerButton {
            button: 0,
            pressed: true,
            x: 0.5,
            y: 0.5,
        }
    }

    #[tokio::test]
    async fn pointer_bursts_coalesce_without_crossing_other_input() {
        let (sender, mut receiver) = channel();
        sender.send(position(0.1)).unwrap();
        sender.send(button()).unwrap();
        for n in 0..10_000 {
            sender.send(position(f64::from(n) / 10_000.)).unwrap();
        }
        let wheel = InputEvent::Wheel {
            delta_x: 0.,
            delta_y: 40.,
        };
        sender.send(wheel.clone()).unwrap();
        sender.send(key("KeyA")).unwrap();
        sender.send(position(1.)).unwrap();
        drop(sender);
        for event in [
            position(0.1),
            button(),
            position(0.9999),
            wheel,
            key("KeyA"),
            position(1.),
        ] {
            assert_eq!(receiver.recv().await.unwrap(), Some(event));
        }
        assert_eq!(receiver.recv().await.unwrap(), None);
    }

    #[tokio::test]
    async fn overflow_releases_in_flight_input_and_accepts_fresh_events() {
        let (sender, mut receiver) = channel();
        sender.send(key("ControlLeft")).unwrap();
        assert_eq!(receiver.recv().await.unwrap(), Some(key("ControlLeft")));
        for _ in 0..CAPACITY {
            sender.send(button()).unwrap();
        }
        // Simulate the session waiting on its already dequeued Control press.
        // The overflowed shortcut must not execute with its modifier discarded.
        sender.send(key("KeyC")).unwrap();
        sender.send(key("KeyB")).unwrap();
        drop(sender);
        assert_eq!(receiver.recv().await.unwrap(), Some(InputEvent::ReleaseAll));
        assert_eq!(receiver.recv().await.unwrap(), Some(key("KeyB")));
        assert_eq!(receiver.recv().await.unwrap(), None);
    }

    #[tokio::test]
    async fn focus_release_discards_pending_presses_before_fresh_input() {
        let (sender, mut receiver) = channel();
        sender.send(key("KeyA")).unwrap();
        sender.send(button()).unwrap();
        sender.send(InputEvent::ReleaseAll).unwrap();
        sender.send(position(0.8)).unwrap();
        drop(sender);
        assert_eq!(receiver.recv().await.unwrap(), Some(InputEvent::ReleaseAll));
        assert_eq!(receiver.recv().await.unwrap(), Some(position(0.8)));
        assert_eq!(receiver.recv().await.unwrap(), None);
    }

    #[tokio::test]
    async fn cancellation_and_channel_closure_do_not_lose_wakeups() {
        let (sender, mut receiver) = channel();
        tokio::select! {
            biased;
            _ = receiver.recv() => panic!("empty input must wait"),
            () = std::future::ready(()) => {},
        }
        let task = tokio::spawn(async move {
            assert_eq!(receiver.recv().await.unwrap(), Some(key("KeyA")));
            assert_eq!(receiver.recv().await.unwrap(), None);
        });
        tokio::task::yield_now().await;
        sender.send(key("KeyA")).unwrap();
        drop(sender);
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();

        let (sender, receiver) = channel();
        drop(receiver);
        assert!(sender.send(key("KeyA")).is_err());
    }
}
