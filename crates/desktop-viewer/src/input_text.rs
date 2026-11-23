//! Committed mobile IME text uses the existing bounded clipboard contract.

use deskfleet_input::InputEvent;
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize)]
pub(crate) enum PasteCode {
    ControlLeft,
    MetaLeft,
}

/// Mobile IMEs clear their local held-input state when submitting a text commit.
/// Keep the matching remote release in the input queue even if the text is rejected.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn mobile_commit_events(text: String, code: PasteCode, shift: bool) -> Vec<InputEvent> {
    paste_events(text, code, shift).unwrap_or_else(|| vec![InputEvent::ReleaseAll])
}

/// Keep the text and its paste chord together on the ordered channel. In
/// particular, a sticky Hacker Keyboard modifier must not modify the paste.
pub(crate) fn paste_events(text: String, code: PasteCode, shift: bool) -> Option<Vec<InputEvent>> {
    let text = crate::clipboard::sanitize(&text)?;
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
    use deskfleet_input::MAX_CLIPBOARD_BYTES;

    #[test]
    fn composed_unicode_is_pasted_after_releasing_sticky_modifiers() {
        let events = mobile_commit_events("你好👋\0".into(), PasteCode::MetaLeft, false);
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
    fn rejected_mobile_commits_only_release_held_input() {
        for rejected in [String::from("\0"), "你".repeat(MAX_CLIPBOARD_BYTES / 3 + 1)] {
            assert_eq!(
                mobile_commit_events(rejected, PasteCode::ControlLeft, true),
                [InputEvent::ReleaseAll]
            );
        }
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
