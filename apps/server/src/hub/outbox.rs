//! Bounded socket delivery: replaceable refresh hints never crowd out commands.
use deskfleet_protocol::control::ControlMessage;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SendError {
    Full,
    Closed,
}

pub(crate) enum Outbound {
    Message(ControlMessage),
    /// Fetch current grants and append the snapshot through the registration gate.
    Reconcile,
}

struct State {
    commands: VecDeque<ControlMessage>,
    hints: VecDeque<ControlMessage>,
    refresh_required: bool,
    reconcile: bool,
    reconciled_last: bool,
    commands_since_hint: usize,
    receiver: bool,
    senders: usize,
}

struct Shared {
    state: Mutex<State>,
    capacity: usize,
    ready: Notify,
    space: Notify,
}

pub(crate) struct Sender(Arc<Shared>);
pub(crate) struct Receiver(Arc<Shared>);

pub(crate) fn channel(capacity: usize) -> (Sender, Receiver) {
    assert!(capacity > 0, "socket queue capacity must be positive");
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            commands: VecDeque::new(),
            hints: VecDeque::new(),
            refresh_required: false,
            reconcile: false,
            reconciled_last: false,
            commands_since_hint: 0,
            receiver: true,
            senders: 1,
        }),
        capacity,
        ready: Notify::new(),
        space: Notify::new(),
    });
    (Sender(shared.clone()), Receiver(shared))
}

impl Clone for Sender {
    fn clone(&self) -> Self {
        self.0
            .state
            .lock()
            .expect("socket queue lock poisoned")
            .senders += 1;
        Self(self.0.clone())
    }
}

impl Drop for Sender {
    fn drop(&mut self) {
        self.0
            .state
            .lock()
            .expect("socket queue lock poisoned")
            .senders -= 1;
        self.0.ready.notify_one();
    }
}

impl Sender {
    pub(crate) fn try_send(&self, message: ControlMessage) -> Result<(), SendError> {
        self.enqueue(message).map_err(|(error, _)| error)
    }

    /// Callers own the delivery deadline; waiting never retains a routing lock.
    pub(crate) async fn send(&self, mut message: ControlMessage) -> Result<(), SendError> {
        loop {
            let space = self.0.space.notified();
            tokio::pin!(space);
            space.as_mut().enable();
            match self.enqueue(message) {
                Ok(()) => return Ok(()),
                Err((SendError::Closed, _)) => return Err(SendError::Closed),
                Err((SendError::Full, pending)) => message = *pending,
            }
            space.await;
        }
    }

    pub(crate) fn request_reconciliation(&self) {
        let mut state = self.0.state.lock().expect("socket queue lock poisoned");
        if !state.receiver {
            return;
        }
        state.reconcile = true;
        drop(state);
        self.0.ready.notify_one();
    }

    fn enqueue(&self, message: ControlMessage) -> Result<(), (SendError, Box<ControlMessage>)> {
        let mut state = self.0.state.lock().expect("socket queue lock poisoned");
        if !state.receiver {
            return Err((SendError::Closed, Box::new(message)));
        }
        if is_hint(&message) {
            if !state.refresh_required {
                if let Some(previous) = state
                    .hints
                    .iter_mut()
                    .find(|previous| same_hint(previous, &message))
                {
                    merge_hint(previous, message);
                } else if state.hints.len() < self.0.capacity {
                    state.hints.push_back(message);
                } else {
                    // One scope-free refresh covers every discarded invalidation,
                    // including presence, without growing a per-client key map.
                    state.hints.clear();
                    state.refresh_required = true;
                }
            }
        } else if matches!(message, ControlMessage::ReconcilePeers { .. }) {
            // Keep the first queued snapshot at its original FIFO position;
            // repeated reconciliations must not move it behind new requests.
            // A newer snapshot cannot replace it in place either: that would
            // move a later revocation ahead of an intervening peer offer.
            if has_snapshot(&state) {
                state.reconcile = true;
            } else {
                state.commands.push_back(message);
            }
        } else {
            let commands = state
                .commands
                .iter()
                .filter(|queued| !matches!(queued, ControlMessage::ReconcilePeers { .. }))
                .count();
            if commands >= self.0.capacity {
                return Err((SendError::Full, Box::new(message)));
            }
            state.commands.push_back(message);
        }
        drop(state);
        self.0.ready.notify_one();
        Ok(())
    }
}

impl Receiver {
    pub(crate) async fn recv(&mut self) -> Option<Outbound> {
        loop {
            let ready = self.0.ready.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            match self.try_recv() {
                Ok(message) => return Some(message),
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => return None,
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {}
            }
            ready.await;
        }
    }

    fn try_recv(&self) -> Result<Outbound, tokio::sync::mpsc::error::TryRecvError> {
        let mut state = self.0.state.lock().expect("socket queue lock poisoned");
        if state.reconcile && !state.reconciled_last && !has_snapshot(&state) {
            state.reconcile = false;
            state.reconciled_last = true;
            return Ok(Outbound::Reconcile);
        }
        // Give refreshes progress under sustained command traffic while favoring
        // peer negotiation, revocation and RPC delivery over background hints.
        if state.commands_since_hint >= 16
            && let Some(message) = take_hint(&mut state)
        {
            return Ok(Outbound::Message(message));
        }
        if let Some(message) = state.commands.pop_front() {
            state.reconciled_last = false;
            state.commands_since_hint = state.commands_since_hint.saturating_add(1);
            self.0.space.notify_waiters();
            return Ok(Outbound::Message(message));
        }
        if state.reconcile {
            state.reconcile = false;
            state.reconciled_last = true;
            return Ok(Outbound::Reconcile);
        }
        if let Some(message) = take_hint(&mut state) {
            return Ok(Outbound::Message(message));
        }
        Err(if state.senders == 0 {
            tokio::sync::mpsc::error::TryRecvError::Disconnected
        } else {
            tokio::sync::mpsc::error::TryRecvError::Empty
        })
    }
}

fn has_snapshot(state: &State) -> bool {
    state
        .commands
        .iter()
        .any(|message| matches!(message, ControlMessage::ReconcilePeers { .. }))
}

fn take_hint(state: &mut State) -> Option<ControlMessage> {
    let message = if state.refresh_required {
        state.refresh_required = false;
        Some(ControlMessage::RefreshRequired)
    } else {
        state.hints.pop_front()
    };
    if message.is_some() {
        state.commands_since_hint = 0;
    }
    message
}

impl Drop for Receiver {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().expect("socket queue lock poisoned");
        state.receiver = false;
        state.commands.clear();
        state.hints.clear();
        drop(state);
        self.0.space.notify_waiters();
    }
}

fn is_hint(message: &ControlMessage) -> bool {
    matches!(
        message,
        ControlMessage::CatalogChanged { .. }
            | ControlMessage::MachinesChanged { .. }
            | ControlMessage::Presence { .. }
    )
}

fn same_hint(previous: &ControlMessage, incoming: &ControlMessage) -> bool {
    match (previous, incoming) {
        (
            ControlMessage::CatalogChanged {
                team_id: a,
                machine_id: b,
                ..
            },
            ControlMessage::CatalogChanged {
                team_id: c,
                machine_id: d,
                ..
            },
        )
        | (
            ControlMessage::Presence {
                team_id: a,
                machine_id: b,
                ..
            },
            ControlMessage::Presence {
                team_id: c,
                machine_id: d,
                ..
            },
        ) => a == c && b == d,
        (
            ControlMessage::MachinesChanged { team_id: a },
            ControlMessage::MachinesChanged { team_id: b },
        ) => a == b,
        _ => false,
    }
}

fn merge_hint(previous: &mut ControlMessage, incoming: ControlMessage) {
    if let (
        ControlMessage::CatalogChanged {
            session_id: previous,
            ..
        },
        ControlMessage::CatalogChanged {
            session_id: incoming,
            ..
        },
    ) = (&mut *previous, &incoming)
    {
        // A machine-wide refresh includes all narrower Session invalidations.
        if previous != incoming {
            *previous = None;
        }
    } else {
        *previous = incoming;
    }
}

#[cfg(test)]
#[path = "outbox_tests.rs"]
mod tests;

/// Existing routing tests inspect wire messages; reconciliation tests use the
/// real receiver to exercise the additional internal wakeup explicitly.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    pub(crate) struct Receiver(super::Receiver);
    pub(crate) fn channel(capacity: usize) -> (Sender, Receiver) {
        let (send, receive) = super::channel(capacity);
        (send, Receiver(receive))
    }
    impl Receiver {
        pub(crate) async fn recv(&mut self) -> Option<ControlMessage> {
            self.0.recv().await.map(wire)
        }
        pub(crate) fn try_recv(
            &mut self,
        ) -> Result<ControlMessage, tokio::sync::mpsc::error::TryRecvError> {
            self.0.try_recv().map(wire)
        }
    }
    fn wire(value: Outbound) -> ControlMessage {
        match value {
            Outbound::Message(message) => message,
            Outbound::Reconcile => panic!("test socket must handle grant reconciliation"),
        }
    }
}
