//! The Config panel: which display to view, whether control is allowed, and
//! the connection itself.

use nsh_base::{SelectItem, select};
use nsh_core::prelude::*;

use super::widgets::{action_button, danger_button, note, section, shell, toggle_row};
use super::{Panel, ToolbarAction, ToolbarState, control_extent, emit};
use crate::nsh_ui::{self, Palette, icon, label};

fn display(state: &ToolbarState, p: Palette) -> impl IntoElement + use<> {
    let ui = &state.ui;
    let locale = ui.locale.as_deref();
    let current = ui
        .displays
        .iter()
        .enumerate()
        .find(|(_, display)| display.id == ui.display_id)
        .map(|(index, display)| nsh_ui::display_label(locale, display, index))
        .unwrap_or_default();
    let items = ui
        .displays
        .iter()
        .enumerate()
        .map(|(index, display)| {
            SelectItem::new(
                display.id.to_string(),
                nsh_ui::display_label(locale, display, index),
            )
        })
        .collect::<Vec<_>>();
    select()
        .items(items)
        .value(ui.display_id.to_string())
        .accessibility_label(label(locale, "display"))
        .margin(px(12.))
        .offset(px(4.))
        .popup_class(format!(
            "bg-[#{:06x}] border border-[#{:06x}] rounded-lg shadow-lg p-1",
            p.surface, p.border
        ))
        .item_class(format!(
            "text-[#{:06x}] text-[13px] px-2 py-2 rounded-md focus:bg-[#{:06x}]",
            p.text, p.hover
        ))
        .trigger(
            view()
                .w_full()
                .h(px(control_extent(32.)))
                .flex_row()
                .items_center()
                .gap(px(8.))
                .px(px(8.))
                .rounded(px(6.))
                .border_1()
                .border_color(rgb(p.border))
                .bg(rgb(p.control))
                .child(icon("monitor", p.muted, 14.))
                .child(
                    text(current)
                        .flex_1()
                        .min_w(px(0.))
                        .truncate()
                        .text_size(px(13.))
                        .text_color(rgb(p.text)),
                )
                .child(icon("chevron", p.muted, 14.)),
        )
        .on_change(|value: &Option<SharedString>| {
            if let Some(id) = value.as_ref().and_then(|value| value.parse().ok()) {
                emit(ToolbarAction::SelectDisplay(id));
            }
        })
        .on_open_change(|event: &nsh_base::SelectEvent| {
            if let nsh_base::SelectEvent::OpenChange(open, _) = event {
                emit(ToolbarAction::SelectOpen(*open));
            }
        })
}

fn session(state: &ToolbarState, p: Palette) -> impl IntoElement + use<> {
    let locale = state.ui.locale.as_deref();
    let mut actions = view()
        .flex_row()
        .flex_wrap()
        .gap(px(8.))
        .child(action_button(
            label(locale, "reconnect"),
            ToolbarAction::Reconnect,
            p,
            false,
        ))
        .child(danger_button(
            label(locale, "disconnect"),
            ToolbarAction::Disconnect,
            p,
        ));
    if state.mobile {
        actions = actions.child(action_button(
            label(locale, "close"),
            ToolbarAction::Close,
            p,
            false,
        ));
    }
    section(label(locale, "session"), p).child(actions)
}

pub(super) fn panel(state: &ToolbarState, p: Palette) -> impl IntoElement + use<> {
    let ui = &state.ui;
    let locale = ui.locale.as_deref();
    let mut body = view().gap(px(14.));
    if !ui.displays.is_empty() {
        body = body.child(section(label(locale, "display"), p).child(display(state, p)));
    }
    body = body.child(
        view()
            .child(toggle_row(
                label(locale, "control"),
                ui.control,
                false,
                ToolbarAction::SetControl,
                p,
            ))
            .child(toggle_row(
                label(locale, "fullscreen"),
                state.fullscreen,
                false,
                |_| ToolbarAction::ToggleFullscreen,
                p,
            )),
    );
    body = body.child(session(state, p));
    if let Some(error) = &ui.settings_error {
        body = body.child(note(error.clone(), p.danger));
    }
    shell(
        state,
        Panel::Config,
        label(locale, "panelConfig"),
        label(locale, "hidePanel"),
        None,
        body,
        p,
    )
}
