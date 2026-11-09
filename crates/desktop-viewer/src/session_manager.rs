//! A native window can replace a media peer without replacing its UI.

use serde_json::json;
use tokio::sync::{mpsc, watch};

use crate::protocol::{self, Command};
use crate::{Error, WindowNotifier, input_queue, queue, session};

pub(crate) async fn run(
    mut commands: mpsc::Receiver<Command>,
    mut input: input_queue::Receiver,
    frames: session::Frames,
    proxy: WindowNotifier,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), Error> {
    let codecs = tokio::task::spawn_blocking(session::supported_codecs).await??;
    protocol::emit(json!({
        "type": "capabilities",
        "codecs": codecs.iter().copied().map(protocol::Codec::from).collect::<Vec<_>>()
    }))?;
    loop {
        let command = tokio::select! {
            _ = shutdown.changed() => return Ok(()),
            command = commands.recv() => command,
        };
        match command {
            Some(command @ Command::Start { .. }) => {
                *frames.lock().map_err(|_| "decoded queue poisoned")? =
                    queue::FrameQueue::default();
                let result = session::run_peer(
                    command,
                    &codecs,
                    &mut commands,
                    &mut input,
                    frames.clone(),
                    proxy.clone(),
                    shutdown.clone(),
                )
                .await;
                // The decoder has stopped; discard its final queued frames before the UI
                // clears the old image or a subsequent peer starts.
                *frames.lock().map_err(|_| "decoded queue poisoned")? =
                    queue::FrameQueue::default();
                if finish_peer(result, &proxy, protocol::emit)? {
                    return Ok(());
                }
            }
            Some(Command::Ui { state }) => ui(&proxy, state),
            Some(Command::SetControl { .. }) => {}
            Some(Command::Stop) => stopped(&proxy)?,
            Some(Command::Close) | None => return Ok(()),
            Some(Command::Answer { .. } | Command::Candidate { .. }) => {
                return Err("viewer signaling received without an active peer".into());
            }
        }
    }
}

fn finish_peer(
    outcome: session::PeerOutcome,
    proxy: &WindowNotifier,
    mut emit: impl FnMut(serde_json::Value) -> std::io::Result<()>,
) -> Result<bool, Error> {
    if let Err(error) = outcome.result {
        emit(json!({"type":"error", "error":error.to_string()}))?;
    }
    if outcome.exit == Some(session::PeerExit::Close) {
        return Ok(true);
    }
    session_ended(proxy);
    if outcome.exit == Some(session::PeerExit::Stop) {
        // A failed decoder may have prompted this Stop. It is joined now, so
        // acknowledge teardown even when its result reported that same failure.
        emit(json!({"type":"stopped"}))?;
    }
    // Without a consumed Stop, the parent's later Stop acknowledges idle teardown.
    Ok(false)
}

pub(crate) fn ui(proxy: &WindowNotifier, state: protocol::UiState) {
    #[cfg(not(target_os = "android"))]
    let _ = proxy.send_event(crate::WindowEvent::Ui(state));
    #[cfg(target_os = "android")]
    let _ = (proxy, state);
}

fn stopped(proxy: &WindowNotifier) -> Result<(), Error> {
    session_ended(proxy);
    protocol::emit(json!({"type":"stopped"}))?;
    Ok(())
}

fn session_ended(proxy: &WindowNotifier) {
    #[cfg(not(target_os = "android"))]
    let _ = proxy.send_event(crate::WindowEvent::SessionEnded);
    #[cfg(target_os = "android")]
    let _ = proxy;
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;
    use session::{PeerExit, PeerOutcome};

    #[test]
    fn decoder_failure_after_stop_still_acknowledges_teardown() {
        let (sender, receiver) = async_channel::unbounded();
        let mut events = Vec::new();
        let outcome = PeerOutcome {
            exit: Some(PeerExit::Stop),
            result: Err("decoder failed".into()),
        };
        let close = finish_peer(outcome, &WindowNotifier(sender), |event| {
            events.push(event);
            Ok(())
        })
        .unwrap();
        assert!(!close);
        assert_eq!(
            events,
            [
                json!({"type":"error", "error":"decoder failed"}),
                json!({"type":"stopped"}),
            ]
        );
        assert!(matches!(
            receiver.try_recv(),
            Ok(crate::WindowEvent::SessionEnded)
        ));
    }

    #[test]
    fn failure_without_stop_waits_for_parent_and_close_remains_terminal() {
        for exit in [None, Some(PeerExit::Close)] {
            let (sender, receiver) = async_channel::unbounded();
            let mut events = Vec::new();
            let close = finish_peer(
                PeerOutcome {
                    exit,
                    result: Err("peer failed".into()),
                },
                &WindowNotifier(sender),
                |event| {
                    events.push(event);
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(close, exit == Some(PeerExit::Close));
            assert_eq!(events, [json!({"type":"error", "error":"peer failed"})]);
            assert_eq!(receiver.try_recv().is_ok(), exit.is_none());
        }
    }
}
