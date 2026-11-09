//! Host snapshots own connection status; media events only drive standalone fixtures.

use crate::WindowEvent;
use crate::protocol::{Status, UiState};

#[derive(Default)]
pub(crate) struct SessionState {
    host_owned: bool,
}

impl SessionState {
    pub(crate) fn update(&mut self, ui: &mut UiState, event: &WindowEvent) {
        match event {
            WindowEvent::Ui(state) => {
                self.host_owned = true;
                *ui = state.clone();
            }
            WindowEvent::SessionEnded => {
                ui.input_ready = false;
                // The host has already selected Connecting, Disconnected, or
                // Error. Old-peer teardown must not replace that intent.
                if !self.host_owned {
                    ui.status = Status::Disconnected;
                }
            }
            _ if self.host_owned => {}
            WindowEvent::Start {
                title,
                control,
                codec,
            } => {
                ui.title = title.clone();
                ui.control = *control;
                ui.codec = Some(*codec);
                ui.status = Status::Connecting;
                ui.input_ready = false;
            }
            WindowEvent::Connected(connected) => {
                ui.status = if *connected {
                    Status::Starting
                } else {
                    Status::Connecting
                };
            }
            WindowEvent::InputReady => ui.input_ready = true,
            _ => {}
        }
    }

    pub(crate) fn frame_ready(&self, ui: &mut UiState, dimensions: (u32, u32)) -> bool {
        if !self.host_owned && dimensions != (0, 0) && ui.status == Status::Starting {
            ui.status = Status::Connected;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Codec;

    #[test]
    fn old_peer_events_cannot_replace_host_connection_intent() {
        // Connecting covers display replacement and automatic codec fallback;
        // Disconnected and Error cover user disconnect and failed negotiation.
        for status in [Status::Connecting, Status::Disconnected, Status::Error] {
            let mut state = SessionState::default();
            let mut ui = UiState::default();
            let snapshot = UiState {
                status,
                control: true,
                ..Default::default()
            };
            state.update(&mut ui, &WindowEvent::Ui(snapshot));
            for event in [
                WindowEvent::Connected(true),
                WindowEvent::InputReady,
                WindowEvent::SessionEnded,
            ] {
                state.update(&mut ui, &event);
                assert!(!state.frame_ready(&mut ui, (64, 64)));
                assert_eq!(ui.status, status);
                assert!(!ui.input_ready);
            }
            state.update(
                &mut ui,
                &WindowEvent::Start {
                    title: "New peer".into(),
                    control: false,
                    codec: Codec::H264,
                },
            );
            assert_eq!(ui.status, status);
            assert!(ui.control);
        }
    }

    #[test]
    fn direct_media_fixture_uses_local_events_until_host_state_arrives() {
        let mut state = SessionState::default();
        let mut ui = UiState::default();
        state.update(
            &mut ui,
            &WindowEvent::Start {
                title: "Fixture".into(),
                control: true,
                codec: Codec::H264,
            },
        );
        state.update(&mut ui, &WindowEvent::Connected(true));
        state.update(&mut ui, &WindowEvent::InputReady);
        assert!(!state.frame_ready(&mut ui, (0, 0)));
        assert!(state.frame_ready(&mut ui, (64, 64)));
        assert_eq!(ui.status, Status::Connected);
        assert!(ui.input_ready);
        state.update(&mut ui, &WindowEvent::SessionEnded);
        assert_eq!(ui.status, Status::Disconnected);
        assert!(!ui.input_ready);
    }
}
