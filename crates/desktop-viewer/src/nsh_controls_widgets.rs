//! Small building blocks shared by the toolbar and its panels.

use nsh_base::{button, switch, tooltip};
use nsh_core::prelude::*;

use super::{BAR_CONTROL_HEIGHT, Panel, ToolbarAction, ToolbarState, control_extent, emit};
use crate::nsh_ui::{Palette, icon};

pub(crate) const PANEL_WIDTH: f32 = 288.;

pub(super) fn hint(title: String, palette: Palette) -> nsh_base::TooltipElement {
    tooltip()
        .px(px(8.))
        .py(px(4.))
        .rounded(px(6.))
        .bg(rgb(palette.surface))
        .border_1()
        .border_color(rgb(palette.border))
        .shadow_md()
        .child(text(title).text_size(px(12.)).text_color(rgb(palette.text)))
}

pub(super) fn action_button(
    title: String,
    action: ToolbarAction,
    palette: Palette,
    disabled: bool,
) -> impl IntoElement {
    button()
        .h(px(control_extent(32.)))
        .px(px(12.))
        .flex_row()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .border_1()
        .border_color(rgb(palette.border))
        .bg(rgb(palette.control))
        .hover(move |s| s.bg(rgb(palette.hover)))
        .accessibility_label(title.clone())
        .disabled(disabled)
        .disabled_style(|s| s.opacity(0.4))
        .on_press(move || emit(action))
        .child(text(title).text_size(px(13.)).text_color(rgb(palette.text)))
}

pub(super) fn danger_button(title: String, action: ToolbarAction, p: Palette) -> impl IntoElement {
    button()
        .h(px(control_extent(32.)))
        .px(px(12.))
        .flex_row()
        .items_center()
        .justify_center()
        .gap(px(6.))
        .rounded(px(6.))
        .border_1()
        .border_color(rgba((p.danger << 8) | 77))
        .bg(rgba((p.danger << 8) | 20))
        .hover(move |s| s.bg(rgba((p.danger << 8) | 35)))
        .accessibility_label(title.clone())
        .on_press(move || emit(action))
        .child(icon("unplug", p.danger, 14.))
        .child(text(title).text_size(px(13.)).text_color(rgb(p.danger)))
}

pub(super) fn icon_button(
    title: String,
    name: &'static str,
    action: ToolbarAction,
    palette: Palette,
    disabled: bool,
) -> impl IntoElement {
    let extent = BAR_CONTROL_HEIGHT;
    view()
        .w(px(extent))
        .h(px(extent))
        .tooltip(hint(title.clone(), palette))
        .child(
            button()
                .w(px(extent))
                .h(px(extent))
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .accessibility_label(title)
                .hover(move |s| s.bg(rgb(palette.hover)))
                .disabled(disabled)
                .disabled_style(|s| s.opacity(0.4))
                .on_press(move || emit(action))
                .child(icon(name, palette.muted, 16.)),
        )
}

/// A toolbar button that opens one panel; it stays highlighted while open.
pub(super) fn trigger<C: IntoElement>(
    state: &ToolbarState,
    panel: Panel,
    title: String,
    content: C,
    p: Palette,
) -> impl IntoElement + use<C> {
    let open = state.panel == Some(panel);
    let mut trigger = button()
        .h(px(BAR_CONTROL_HEIGHT))
        .min_w(px(BAR_CONTROL_HEIGHT))
        .px(px(6.))
        .flex_row()
        .items_center()
        .justify_center()
        .gap(px(6.))
        .rounded(px(6.))
        .accessibility_label(title.clone())
        .hover(move |s| s.bg(rgb(p.hover)))
        .on_press(move || emit(ToolbarAction::TogglePanel(panel)))
        .child(content);
    if open {
        trigger = trigger.bg(rgb(p.hover));
    }
    view().tooltip(hint(title, p)).child(trigger)
}

/// A setting that takes effect at once: its label, then a switch.
pub(super) fn toggle_row(
    title: String,
    checked: bool,
    disabled: bool,
    action: fn(bool) -> ToolbarAction,
    p: Palette,
) -> impl IntoElement {
    let track = format!(
        "w-9 h-5 rounded-full p-0.5 flex-row items-center {} bg-[#{:06x}]",
        if checked {
            "justify-end"
        } else {
            "justify-start"
        },
        if checked { p.accent } else { p.faint },
    );
    switch()
        .checked(checked)
        .disabled(disabled)
        .accessibility_label(title.clone())
        .hit_slop(4.)
        .min_h(px(control_extent(32.)))
        .w_full()
        .flex_row_reverse()
        .items_center()
        .gap(px(12.))
        .opacity(if disabled { 0.4 } else { 1. })
        .track_class(track)
        .thumb_class("w-4 h-4 rounded-full bg-white shadow-sm")
        .on_change(move |enabled: &bool| emit(action(*enabled)))
        .child(
            text(title)
                .flex_1()
                .min_w(px(0.))
                .text_size(px(13.))
                .text_color(rgb(p.text)),
        )
}

pub(super) struct Choice {
    pub(super) title: String,
    pub(super) icon: &'static str,
    pub(super) selected: bool,
    pub(super) action: ToolbarAction,
}

/// Mutually exclusive modes; pressing the current one does nothing.
pub(super) fn segmented(choices: Vec<Choice>, disabled: bool, p: Palette) -> impl IntoElement {
    let mut row = view()
        .flex_row()
        .p(px(2.))
        .gap(px(2.))
        .rounded(px(8.))
        .bg(rgb(p.hover))
        .opacity(if disabled { 0.4 } else { 1. });
    for choice in choices {
        let Choice {
            title,
            icon: name,
            selected,
            action,
        } = choice;
        let color = if selected { p.text } else { p.muted };
        let mut segment = button()
            .flex_1()
            .h(px(control_extent(32.) - 4.))
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .rounded(px(6.))
            .accessibility_label(title.clone())
            .disabled(disabled)
            .on_press(move || {
                if !selected {
                    emit(action);
                }
            })
            .child(icon(name, color, 14.))
            .child(text(title).text_size(px(13.)).text_color(rgb(color)));
        if selected {
            segment = segment
                .bg(rgb(p.surface))
                .border_1()
                .border_color(rgb(p.border))
                .shadow_sm();
        }
        row = row.child(segment);
    }
    row
}

/// A named group of rows inside a panel.
pub(super) fn section(title: String, p: Palette) -> View {
    view().gap(px(4.)).child(
        text(title)
            .text_size(px(11.))
            .font_weight(FontWeight::MEDIUM)
            .uppercase()
            .text_color(rgb(p.muted)),
    )
}

pub(super) fn note(message: String, color: u32) -> impl IntoElement {
    text(message).text_size(px(12.)).text_color(rgb(color))
}

/// The dropdown body shared by the Control, Config, and Monitor panels.
pub(super) fn shell<B: IntoElement>(
    state: &ToolbarState,
    panel: Panel,
    title: String,
    close: String,
    badge: Option<AnyElement>,
    body: B,
    p: Palette,
) -> impl IntoElement + use<B> {
    let mut header = view().flex_row().items_center().gap(px(8.)).child(
        text(title.clone())
            .flex_1()
            .min_w(px(0.))
            .truncate()
            .text_size(px(14.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(rgb(p.text)),
    );
    if let Some(badge) = badge {
        header = header.child(badge);
    }
    header = header.child(icon_button(
        close,
        "close",
        ToolbarAction::TogglePanel(panel),
        p,
        false,
    ));
    scroll()
        .absolute()
        .left(px(state.panel_position.0))
        .top(px(state.panel_position.1))
        .w(px(PANEL_WIDTH.min((state.viewport.0 - 24.).max(0.))))
        .max_h(px((state.viewport.1 - 24.).max(0.)))
        .rounded(px(12.))
        .border_1()
        .border_color(rgb(p.border))
        .bg(rgb(p.surface))
        .shadow_lg()
        .label(title)
        .on_layout(|frame: &Bounds<Points>| emit(ToolbarAction::PanelMeasured(frame.size.height.0)))
        .child(
            view()
                .pt(px(8.))
                .px(px(12.))
                .pb(px(12.))
                .gap(px(14.))
                .child(header)
                .child(body),
        )
}
