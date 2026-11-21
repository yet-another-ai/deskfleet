//! Committed mobile IME text uses the existing bounded clipboard contract.

use deskfleet_input::{InputEvent, MAX_CLIPBOARD_BYTES};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize)]
pub(crate) enum PasteCode {
    ControlLeft,
    MetaLeft,
}

/// Keep the text and its paste chord together on the ordered channel. In
/// particular, a sticky Hacker Keyboard modifier must not modify the paste.
pub(crate) fn paste_events(text: String, code: PasteCode, shift: bool) -> Option<Vec<InputEvent>> {
    let text = text.replace('\0', "");
    if text.is_empty() || text.len() > MAX_CLIPBOARD_BYTES {
        return None;
    }
    let code = match code {
        PasteCode::ControlLeft => "ControlLeft",
        PasteCode::MetaLeft => "MetaLeft",
    };
    let key = |code: &str, pressed| InputEvent::Key {
        code: code.into(),
        pressed,
        repeat: false,
    };
    let mut events = vec![
        InputEvent::ReleaseAll,
        InputEvent::Clipboard { text },
        key(code, true),
    ];
    if shift {
        events.push(key("ShiftLeft", true));
    }
    events.extend([key("KeyV", true), key("KeyV", false)]);
    if shift {
        events.push(key("ShiftLeft", false));
    }
    events.push(key(code, false));
    Some(events)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composed_unicode_is_pasted_after_releasing_sticky_modifiers() {
        let events = paste_events("你好👋\0".into(), PasteCode::MetaLeft, false).unwrap();
        assert_eq!(events[0], InputEvent::ReleaseAll);
        assert_eq!(
            events[1],
            InputEvent::Clipboard {
                text: "你好👋".into()
            }
        );
        for (event, (code, pressed)) in events[2..].iter().zip([
            ("MetaLeft", true),
            ("KeyV", true),
            ("KeyV", false),
            ("MetaLeft", false),
        ]) {
            assert_eq!(
                event,
                &InputEvent::Key {
                    code: code.into(),
                    pressed,
                    repeat: false
                }
            );
        }
    }

    #[test]
    fn text_is_bounded_in_utf8_bytes_and_empty_commits_do_nothing() {
        assert!(paste_events("\0".into(), PasteCode::ControlLeft, false).is_none());
        assert!(
            paste_events(
                "a".repeat(MAX_CLIPBOARD_BYTES),
                PasteCode::ControlLeft,
                false
            )
            .is_some()
        );
        assert!(
            paste_events(
                "你".repeat(MAX_CLIPBOARD_BYTES / 3 + 1),
                PasteCode::ControlLeft,
                false
            )
            .is_none()
        );
    }

    #[test]
    fn terminal_paste_releases_shift_and_control_after_pasting() {
        let events = paste_events("ls".into(), PasteCode::ControlLeft, true).unwrap();
        let keys: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                InputEvent::Key { code, pressed, .. } => Some((code.as_str(), *pressed)),
                _ => None,
            })
            .collect();
        assert_eq!(
            keys,
            [
                ("ControlLeft", true),
                ("ShiftLeft", true),
                ("KeyV", true),
                ("KeyV", false),
                ("ShiftLeft", false),
                ("ControlLeft", false)
            ]
        );
    }
}
