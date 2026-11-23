//! Each mounted iOS video view tracks its own pasteboard baseline and peer.
use std::cell::{Cell, RefCell};

use deskfleet_input::InputEvent;

use crate::clipboard::{ClipboardIntent, ClipboardPolicy, is_paste_candidate};

pub(crate) trait Pasteboard {
    fn change_count(&self) -> isize;
    fn read_text(&self) -> Option<String>;
    fn write_text(&self, text: &str);
}

pub(crate) struct ViewClipboard<P> {
    board: P,
    policy: RefCell<ClipboardPolicy>,
    enabled: Cell<bool>,
    sharing: Cell<bool>,
    observed: Cell<isize>,
    pasted: Cell<Option<isize>>,
    reading: Cell<bool>,
    // A UIKit read can reenter the view and change its session or permissions.
    revision: Cell<u64>,
}

impl<P: Pasteboard> ViewClipboard<P> {
    pub(crate) fn new(board: P) -> Self {
        Self {
            observed: Cell::new(board.change_count()),
            board,
            policy: RefCell::default(),
            enabled: Cell::new(false),
            sharing: Cell::new(true),
            pasted: Cell::default(),
            reading: Cell::default(),
            revision: Cell::default(),
        }
    }

    pub(crate) fn configure(&self, enabled: bool, sharing: bool) {
        if self.enabled.get() != enabled || self.sharing.get() != sharing {
            self.revision.update(|v| v.wrapping_add(1));
            self.enabled.set(enabled);
            self.sharing.set(sharing);
        }
    }

    pub(crate) fn reset_session(&self) {
        self.revision.update(|v| v.wrapping_add(1));
        self.policy.borrow_mut().reset_session();
        self.observed.set(self.board.change_count());
        self.pasted.set(None);
    }

    pub(crate) fn local(&self, intent: ClipboardIntent) -> Option<InputEvent> {
        if !self.enabled.get() || (!self.sharing.get() && intent != ClipboardIntent::Explicit) {
            return None;
        }
        let revision = self.revision.get();
        let count = self.board.change_count();
        // Opening or activating the viewer must not read an unchanged pasteboard.
        // A deliberate paste can read the opening baseline once per change.
        match intent {
            ClipboardIntent::Paste if self.pasted.get() == Some(count) => return None,
            ClipboardIntent::Changed | ClipboardIntent::Focus if self.observed.get() == count => {
                return None;
            }
            _ => {}
        }
        if self.reading.replace(true) {
            return None;
        }
        let text = self.board.read_text();
        self.reading.set(false);
        if self.revision.get() != revision {
            return None;
        }
        self.observed.set(count);
        if text.is_some() || intent == ClipboardIntent::Paste {
            self.pasted.set(Some(count));
        }
        // The opening baseline is a change count; the first changed count is
        // already a local copy, even if its notification arrived on activation.
        let intent = if intent == ClipboardIntent::Focus {
            ClipboardIntent::Changed
        } else {
            intent
        };
        let text = self.policy.borrow_mut().local(
            intent,
            self.enabled.get(),
            self.sharing.get(),
            text.as_deref(),
        )?;
        Some(InputEvent::Clipboard { text })
    }

    pub(crate) fn before_keys(&self, events: &mut Vec<InputEvent>) {
        if events.iter().any(is_paste_candidate)
            && let Some(clip) = self.local(ClipboardIntent::Paste)
        {
            let after_release = usize::from(events.first() == Some(&InputEvent::ReleaseAll));
            events.insert(after_release, clip);
        }
    }

    pub(crate) fn remote(&self, raw: &str) {
        let text = self
            .policy
            .borrow_mut()
            .remote(self.enabled.get(), self.sharing.get(), raw);
        if let Some(text) = text {
            self.revision.update(|v| v.wrapping_add(1));
            let revision = self.revision.get();
            self.board.write_text(&text);
            if self.revision.get() == revision {
                let count = self.board.change_count();
                self.observed.set(count);
                self.pasted.set(Some(count));
            }
        }
    }
}

#[cfg(test)]
#[path = "clipboard_ios_tests.rs"]
mod tests;
