//! Bidirectional plain-text clipboard synchronization for the native GPUI viewer.

use deskfleet_input::{InputEvent, MAX_CLIPBOARD_BYTES};
use gpui::{App, ClipboardItem};

pub(crate) struct ClipboardSync {
    baseline: Option<String>,
    last_synced: Option<String>,
}

impl ClipboardSync {
    pub(crate) fn new(cx: &App) -> Self {
        Self {
            baseline: read_local_text(cx),
            last_synced: None,
        }
    }

    pub(crate) fn reset_session(&mut self, cx: &App) {
        self.baseline = read_local_text(cx);
        self.last_synced = None;
    }

    /// Syncs local clipboard on window focus when the user copied new text
    /// outside the viewer after it opened.
    pub(crate) fn on_window_active(&mut self, enabled: bool, cx: &App) -> Option<InputEvent> {
        if !enabled {
            return None;
        }
        let text = read_local_text(cx)?;
        if self.baseline.as_deref() == Some(text.as_str())
            || self.last_synced.as_deref() == Some(text.as_str())
        {
            return None;
        }
        self.baseline = Some(text.clone());
        self.last_synced = Some(text.clone());
        Some(InputEvent::Clipboard { text })
    }

    /// Syncs local clipboard right before a potential paste shortcut (`KeyV`,
    /// `Insert`) or context/middle click (`button != 0`), including text that
    /// was already on the clipboard before the viewer window opened.
    pub(crate) fn before_events(
        &mut self,
        enabled: bool,
        events: &[InputEvent],
        cx: &App,
    ) -> Option<InputEvent> {
        if !enabled || !events.iter().any(is_paste_candidate) {
            return None;
        }
        let text = read_local_text(cx)?;
        if self.last_synced.as_deref() == Some(text.as_str()) {
            return None;
        }
        self.baseline = Some(text.clone());
        self.last_synced = Some(text.clone());
        Some(InputEvent::Clipboard { text })
    }

    pub(crate) fn apply_remote(&mut self, enabled: bool, text: String, cx: &mut App) {
        if !enabled || text.is_empty() || text.len() > MAX_CLIPBOARD_BYTES {
            return;
        }
        let sanitized = text.replace('\0', "");
        if sanitized.is_empty() {
            return;
        }
        self.baseline = Some(sanitized.clone());
        if self.last_synced.as_deref() == Some(sanitized.as_str()) {
            return;
        }
        self.last_synced = Some(sanitized.clone());
        cx.write_to_clipboard(ClipboardItem::new_string(sanitized));
    }
}

fn read_local_text(cx: &App) -> Option<String> {
    let text = cx.read_from_clipboard()?.text()?.replace('\0', "");
    (!text.is_empty() && text.len() <= MAX_CLIPBOARD_BYTES).then_some(text)
}

fn is_paste_candidate(event: &InputEvent) -> bool {
    match event {
        InputEvent::Key {
            code,
            pressed: true,
            repeat: false,
        } => matches!(code.as_str(), "KeyV" | "Insert"),
        InputEvent::PointerButton {
            button,
            pressed: true,
            ..
        } => *button != 0,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_paste_keys_and_non_primary_clicks() {
        assert!(is_paste_candidate(&InputEvent::Key {
            code: "KeyV".into(),
            pressed: true,
            repeat: false,
        }));
        assert!(is_paste_candidate(&InputEvent::Key {
            code: "Insert".into(),
            pressed: true,
            repeat: false,
        }));
        assert!(!is_paste_candidate(&InputEvent::Key {
            code: "KeyA".into(),
            pressed: true,
            repeat: false,
        }));
        assert!(is_paste_candidate(&InputEvent::PointerButton {
            button: 2,
            pressed: true,
            x: 0.5,
            y: 0.5,
        }));
        assert!(!is_paste_candidate(&InputEvent::PointerButton {
            button: 0,
            pressed: true,
            x: 0.5,
            y: 0.5,
        }));
    }
}
