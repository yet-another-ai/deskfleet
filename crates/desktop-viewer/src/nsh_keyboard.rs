//! One Hacker Keyboard component for every native viewer host.

#[cfg(any(test, not(any(target_os = "android", target_os = "ios"))))]
use deskfleet_input::InputEvent;
use nsh_base::button;
use nsh_core::prelude::*;

use crate::nsh_controls::{ToolbarAction, ToolbarState, emit};
use crate::nsh_ui::{Palette, icon, label};

pub(crate) const MODIFIERS: [&str; 4] = ["ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft"];

const ROWS: &[&[(&str, &str)]] = &[
    &[
        ("Esc", "Escape"),
        ("Tab", "Tab"),
        ("⌫", "Backspace"),
        ("↵", "Enter"),
        ("Ins", "Insert"),
        ("Del", "Delete"),
    ],
    &[
        ("←", "ArrowLeft"),
        ("↓", "ArrowDown"),
        ("↑", "ArrowUp"),
        ("→", "ArrowRight"),
        ("Home", "Home"),
        ("End", "End"),
    ],
    &[
        ("F1", "F1"),
        ("F2", "F2"),
        ("F3", "F3"),
        ("F4", "F4"),
        ("F5", "F5"),
        ("F6", "F6"),
    ],
    &[
        ("F7", "F7"),
        ("F8", "F8"),
        ("F9", "F9"),
        ("F10", "F10"),
        ("F11", "F11"),
        ("F12", "F12"),
    ],
    &[
        ("A", "KeyA"),
        ("C", "KeyC"),
        ("V", "KeyV"),
        ("X", "KeyX"),
        ("Z", "KeyZ"),
        ("Space", "Space"),
    ],
    &[("PgUp", "PageUp"), ("PgDn", "PageDown")],
];

fn key_button(
    title: &'static str,
    action: ToolbarAction,
    state: &ToolbarState,
    p: Palette,
    selected: bool,
) -> impl IntoElement {
    button()
        .flex_1()
        .min_w(px(0.))
        .h(px(if state.mobile { 40. } else { 32. }))
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .border_1()
        .border_color(rgb(if selected { p.accent } else { p.border }))
        .bg(rgb(if selected { p.hover } else { p.control }))
        .hover(move |s| s.bg(rgb(p.hover)))
        .disabled(!state.controls_enabled())
        .disabled_style(|s| s.opacity(0.4))
        .accessibility_label(title)
        .on_press(move || emit(action))
        .child(text(title).text_size(px(13.)).text_color(rgb(if selected {
            p.accent
        } else {
            p.text
        })))
}

pub(crate) fn panel(state: &ToolbarState, p: Palette) -> impl IntoElement + use<> {
    let locale = state.ui.locale.as_deref();
    let mut keys = view().gap(px(4.)).p(px(8.)).child(
        view()
            .flex_row()
            .items_center()
            .justify_between()
            .child(
                text(label(locale, "hackerKeyboard"))
                    .text_size(px(13.))
                    .text_color(rgb(p.text)),
            )
            .child(
                button()
                    .w(px(40.))
                    .h(px(32.))
                    .items_center()
                    .justify_center()
                    .accessibility_label(label(locale, "hideKeyboard"))
                    .on_press(|| emit(ToolbarAction::ToggleHackerKeyboard))
                    .child(icon("close", p.muted, 16.)),
            ),
    );
    let mut modifiers = view().flex_row().gap(px(4.));
    for (index, (title, code)) in ["Ctrl", "Alt", "Shift", "Meta"]
        .into_iter()
        .zip(MODIFIERS)
        .enumerate()
    {
        modifiers = modifiers.child(key_button(
            title,
            ToolbarAction::ToggleModifier(code),
            state,
            p,
            state.modifiers[index],
        ));
    }
    keys = keys.child(modifiers);
    for row in ROWS {
        let mut controls = view().flex_row().gap(px(4.));
        for &(title, code) in *row {
            controls = controls.child(key_button(title, ToolbarAction::Key(code), state, p, false));
        }
        keys = keys.child(controls);
    }
    keys = keys.child(
        text(label(locale, "keyboardModifiersHint"))
            .text_size(px(11.))
            .text_color(rgb(p.muted)),
    );
    scroll()
        .absolute()
        .left(px(state.keyboard_position.0))
        .top(px(state.keyboard_position.1))
        .w(px(520_f32
            .min((state.viewport.0 - 24.).max(0.))
            .min(state.keyboard_size.0)))
        .max_h(px((state.viewport.1 - 24.)
            .max(0.)
            .min(state.keyboard_size.1)))
        .rounded(px(12.))
        .border_1()
        .border_color(rgb(p.border))
        .bg(rgb(p.surface))
        .shadow_lg()
        .label(label(locale, "hackerKeyboard"))
        .on_layout(|frame: &Bounds<Points>| {
            emit(ToolbarAction::KeyboardMeasured(
                frame.size.width.0,
                frame.size.height.0,
            ))
        })
        .child(keys)
}

/// A complete one-shot chord; no selected modifier remains down remotely.
#[cfg(any(test, not(any(target_os = "android", target_os = "ios"))))]
pub(crate) fn key_events(modifiers: [bool; 4], code: &str) -> Vec<InputEvent> {
    let key = |code: &str, pressed| InputEvent::Key {
        code: code.into(),
        pressed,
        repeat: false,
    };
    let mut events = vec![InputEvent::ReleaseAll];
    for (selected, modifier) in modifiers.into_iter().zip(MODIFIERS) {
        if selected {
            events.push(key(modifier, true));
        }
    }
    events.extend([key(code, true), key(code, false)]);
    for (selected, modifier) in modifiers.into_iter().zip(MODIFIERS).rev() {
        if selected {
            events.push(key(modifier, false));
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_modifiers_wrap_one_complete_key_in_order() {
        let events = key_events([true, true, false, true], "Delete");
        assert_eq!(events[0], InputEvent::ReleaseAll);
        let keys: Vec<_> = events
            .iter()
            .skip(1)
            .map(|event| {
                let InputEvent::Key {
                    code,
                    pressed,
                    repeat,
                } = event
                else {
                    panic!("expected key")
                };
                assert!(!repeat);
                (code.as_str(), *pressed)
            })
            .collect();
        assert_eq!(
            keys,
            [
                ("ControlLeft", true),
                ("AltLeft", true),
                ("MetaLeft", true),
                ("Delete", true),
                ("Delete", false),
                ("MetaLeft", false),
                ("AltLeft", false),
                ("ControlLeft", false)
            ]
        );
    }
}
