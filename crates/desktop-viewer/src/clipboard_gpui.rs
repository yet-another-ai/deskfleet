//! GPUI supplies clipboard access; the shared policy decides what crosses peers.

use deskfleet_input::InputEvent;
use gpui::{App, ClipboardItem};

use crate::clipboard::{ClipboardIntent, ClipboardPolicy, is_paste_candidate};

pub(crate) struct ClipboardSync(ClipboardPolicy);

impl ClipboardSync {
    pub(crate) fn new(cx: &App) -> Self {
        let mut sync = Self(ClipboardPolicy::default());
        sync.reset_session(cx);
        sync
    }

    pub(crate) fn reset_session(&mut self, cx: &App) {
        self.0.reset_session();
        self.0.seed_baseline(read_local_text(cx).as_deref());
    }

    pub(crate) fn on_window_active(&mut self, enabled: bool, cx: &App) -> Option<InputEvent> {
        self.local(ClipboardIntent::Focus, enabled, cx)
    }

    pub(crate) fn explicit(&mut self, enabled: bool, cx: &App) -> Option<InputEvent> {
        self.local(ClipboardIntent::Explicit, enabled, cx)
    }

    pub(crate) fn before_events(
        &mut self,
        enabled: bool,
        events: &[InputEvent],
        cx: &App,
    ) -> Option<InputEvent> {
        if !events.iter().any(is_paste_candidate) {
            return None;
        }
        self.local(ClipboardIntent::Paste, enabled, cx)
    }

    fn local(&mut self, intent: ClipboardIntent, enabled: bool, cx: &App) -> Option<InputEvent> {
        if !enabled {
            return None;
        }
        self.0
            .local(intent, enabled, true, read_local_text(cx).as_deref())
            .map(|text| InputEvent::Clipboard { text })
    }

    pub(crate) fn apply_remote(&mut self, enabled: bool, text: String, cx: &mut App) {
        if let Some(text) = self.0.remote(enabled, true, &text) {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }
}

fn read_local_text(cx: &App) -> Option<String> {
    cx.read_from_clipboard()?.text()
}
