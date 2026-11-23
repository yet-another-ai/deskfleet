//! Clipboard policy shared by desktop and mobile viewers. Hosts own OS access.

#[cfg(any(not(target_os = "android"), test))]
use deskfleet_input::InputEvent;
use deskfleet_input::MAX_CLIPBOARD_BYTES;
use serde::Deserialize;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) use crate::clipboard_gpui::ClipboardSync;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ClipboardIntent {
    Focus,
    Changed,
    Paste,
    Explicit,
}

/// Text is compared after sanitization, and the limit counts UTF-8 bytes.
pub(crate) fn sanitize(text: &str) -> Option<String> {
    let text = text.replace('\0', "");
    (!text.is_empty() && text.len() <= MAX_CLIPBOARD_BYTES).then_some(text)
}

#[derive(Default)]
pub(crate) struct ClipboardPolicy {
    baseline_seeded: bool,
    baseline: Option<String>,
    last_synced: Option<String>,
}

impl ClipboardPolicy {
    /// Discard the previous peer's dedup state. A host that can read immediately
    /// may seed its new baseline; otherwise the first focus observation seeds it.
    pub(crate) fn reset_session(&mut self) {
        *self = Self::default();
    }

    pub(crate) fn seed_baseline(&mut self, text: Option<&str>) {
        self.baseline = text.and_then(sanitize);
        self.baseline_seeded = true;
    }

    pub(crate) fn local(
        &mut self,
        intent: ClipboardIntent,
        input_enabled: bool,
        sharing: bool,
        raw_text: Option<&str>,
    ) -> Option<String> {
        // Focus establishes the opening baseline even before control is ready.
        // It must never overwrite the remote clipboard merely by opening a view.
        if intent == ClipboardIntent::Focus && !self.baseline_seeded {
            self.seed_baseline(raw_text);
            return None;
        }
        if !input_enabled || (!sharing && intent != ClipboardIntent::Explicit) {
            return None;
        }
        let text = raw_text.and_then(sanitize)?;
        if intent == ClipboardIntent::Focus && self.baseline.as_deref() == Some(&text) {
            return None;
        }
        self.baseline_seeded = true;
        self.baseline = Some(text.clone());
        if self.last_synced.as_deref() == Some(&text) {
            return None;
        }
        self.last_synced = Some(text.clone());
        Some(text)
    }

    pub(crate) fn remote(
        &mut self,
        input_enabled: bool,
        sharing: bool,
        raw_text: &str,
    ) -> Option<String> {
        if !input_enabled || !sharing {
            return None;
        }
        let text = sanitize(raw_text)?;
        self.baseline_seeded = true;
        self.baseline = Some(text.clone());
        if self.last_synced.as_deref() == Some(&text) {
            return None;
        }
        self.last_synced = Some(text.clone());
        Some(text)
    }
}

/// Synchronize before paste keys and context/middle clicks, preserving ordering
/// with the subsequent input events. Repeats and releases are not new pastes.
#[cfg(any(not(target_os = "android"), test))]
pub(crate) fn is_paste_candidate(event: &InputEvent) -> bool {
    match event {
        InputEvent::Key {
            code,
            pressed: true,
            repeat: false,
        } => {
            matches!(code.as_str(), "KeyV" | "Insert")
        }
        InputEvent::PointerButton {
            button,
            pressed: true,
            ..
        } => *button != 0,
        _ => false,
    }
}

#[cfg(test)]
#[path = "clipboard_tests.rs"]
mod tests;
