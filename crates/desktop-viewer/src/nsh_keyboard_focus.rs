//! Keyboard ownership follows current UI geometry, not the last hover result.

use gpui::{Bounds, Pixels, Point};

use crate::nsh_toolbar::ToolbarState;

#[derive(Default)]
pub(crate) struct KeyboardFocus {
    pointer_exited: bool,
    resumed: bool,
}

impl KeyboardFocus {
    pub(crate) fn pointer_moved(&mut self) {
        self.pointer_exited = false;
        self.resumed = false;
    }

    pub(crate) fn pointer_exited(&mut self) {
        // GPUI retains the last coordinates on exit; on macOS its window-hover
        // query also follows activation rather than pointer presence.
        self.pointer_exited = true;
        self.resumed = false;
    }

    pub(crate) fn resume(&mut self) {
        // Explicit Resume restores keyboard focus while still over its button.
        self.resumed = true;
    }

    pub(crate) fn blur(&mut self) {
        self.resumed = false;
    }

    pub(crate) fn enabled(
        &self,
        state: &ToolbarState,
        pointer: Option<Point<Pixels>>,
        content: Bounds<Pixels>,
        toolbar: Bounds<Pixels>,
    ) -> bool {
        state.controls_enabled()
            && !state.settings_open
            && (self.resumed
                || self.pointer_exited
                || pointer.is_none_or(|position| {
                    content.contains(&position) && !toolbar.contains(&position)
                }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Status;
    use gpui::{point, px, size};

    fn content() -> Bounds<Pixels> {
        Bounds::new(point(px(6.), px(38.)), size(px(948.), px(596.)))
    }

    fn toolbar() -> Bounds<Pixels> {
        Bounds::new(point(px(454.), px(50.)), size(px(488.), px(42.)))
    }

    fn connected() -> ToolbarState {
        let mut state = ToolbarState::default();
        state.ui.status = Status::Connected;
        state.ui.control = true;
        state.ui.input_ready = true;
        state
    }

    #[test]
    fn stationary_video_pointer_recovers_when_host_connection_becomes_ready() {
        let focus = KeyboardFocus::default();
        let mut state = connected();
        let pointer = Some(point(px(400.), px(300.)));
        state.ui.status = Status::Connecting;
        assert!(!focus.enabled(&state, pointer, content(), toolbar()));
        state.ui.status = Status::Connected;
        assert!(focus.enabled(&state, pointer, content(), toolbar()));
        // A layout change is also evaluated without another mouse event.
        let moved_toolbar = Bounds::new(point(px(350.), px(280.)), toolbar().size);
        assert!(!focus.enabled(&state, pointer, content(), moved_toolbar));
        assert!(focus.enabled(&state, pointer, content(), toolbar()));
    }

    #[test]
    fn local_controls_remain_local_across_state_updates_and_pointer_exit() {
        let mut focus = KeyboardFocus::default();
        let mut state = connected();
        let pointer = Some(toolbar().center());
        assert!(!focus.enabled(&state, pointer, content(), toolbar()));
        state.ui.status = Status::Connecting;
        assert!(!focus.enabled(&state, pointer, content(), toolbar()));
        state.ui.status = Status::Connected;
        assert!(!focus.enabled(&state, pointer, content(), toolbar()));
        focus.pointer_exited();
        focus.blur();
        // Reactivation must ignore the retained pre-exit toolbar coordinates.
        assert!(focus.enabled(&state, pointer, content(), toolbar()));
        focus.pointer_moved();
        assert!(!focus.enabled(&state, pointer, content(), toolbar()));
        assert!(focus.enabled(&state, None, content(), toolbar()));
        assert!(!focus.enabled(&state, Some(point(px(400.), px(20.))), content(), toolbar()));
    }

    #[test]
    fn explicit_resume_lasts_until_pointer_motion_or_focus_loss() {
        let mut focus = KeyboardFocus::default();
        let mut state = connected();
        let pointer = Some(toolbar().center());
        focus.resume();
        assert!(focus.enabled(&state, pointer, content(), toolbar()));
        state.paused = true;
        assert!(!focus.enabled(&state, pointer, content(), toolbar()));
        state.paused = false;
        state.settings_open = true;
        assert!(!focus.enabled(&state, pointer, content(), toolbar()));
        state.settings_open = false;
        focus.pointer_moved();
        assert!(!focus.enabled(&state, pointer, content(), toolbar()));
        focus.resume();
        focus.blur();
        assert!(!focus.enabled(&state, pointer, content(), toolbar()));
    }
}
