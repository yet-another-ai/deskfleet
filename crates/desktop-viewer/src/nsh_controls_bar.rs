//! The floating toolbar: a grip and one trigger for each panel.
//!
//! The bar shows only what changes how the viewer behaves right now: whether
//! input reaches the remote desktop, and how healthy the stream is. Everything
//! else lives in the panels.

use nsh_core::prelude::*;

use super::widgets::{hint, icon_button, trigger};
use super::{
    BAR_CONTROL_HEIGHT, GRIP_WIDTH, Live, PADDING, Panel, ToolbarAction, ToolbarState, emit,
};
use crate::nsh_ui::{Palette, icon, label};
use crate::protocol::Status;
use crate::stream_stats::{Quality, StreamStats};

/// The Control trigger's mode: what the user's input does right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    Active,
    Paused,
    ViewOnly,
}

impl Mode {
    pub(super) fn of(state: &ToolbarState) -> Self {
        if !state.ui.control {
            Self::ViewOnly
        } else if state.paused {
            Self::Paused
        } else {
            Self::Active
        }
    }

    fn label_key(self) -> &'static str {
        match self {
            Self::Active => "panelControl",
            Self::Paused => "controlPaused",
            Self::ViewOnly => "viewOnly",
        }
    }

    fn icon(self, state: &ToolbarState) -> &'static str {
        match self {
            Self::Paused => "pause",
            Self::ViewOnly => "eye",
            Self::Active if !state.mobile => "mouse",
            Self::Active if state.relative_mouse => "trackpad",
            Self::Active => "pointer",
        }
    }
}

pub(super) fn quality_color(quality: Quality, p: Palette) -> u32 {
    match quality {
        Quality::Waiting => p.faint,
        Quality::Good => p.success,
        Quality::Fair => p.warning,
        Quality::Poor => p.danger,
    }
}

pub(super) fn quality_key(quality: Quality) -> &'static str {
    match quality {
        Quality::Waiting => "qualityWaiting",
        Quality::Good => "qualityGood",
        Quality::Fair => "qualityFair",
        Quality::Poor => "qualityPoor",
    }
}

pub(super) fn dot(color: u32) -> impl IntoElement {
    view()
        .w(px(8.))
        .h(px(8.))
        .flex_shrink_0()
        .rounded(px(4.))
        .bg(rgb(color))
}

fn frame_rate(stats: &StreamStats) -> String {
    if stats.live {
        format!("{:.0} fps", stats.fps)
    } else {
        "—".into()
    }
}

fn grip(state: &ToolbarState, p: Palette) -> impl IntoElement {
    let locale = state.ui.locale.as_deref();
    view()
        .role(AccessibilityRole::Button)
        .on_press(|| emit(ToolbarAction::FocusHandle))
        .w(px(GRIP_WIDTH))
        .h(px(BAR_CONTROL_HEIGHT))
        .flex_shrink_0()
        .rounded(px(6.))
        .items_center()
        .justify_center()
        .label(label(locale, "moveControls"))
        .tooltip(hint(label(locale, "moveControls"), p))
        .hover(move |s| s.bg(rgb(p.hover)))
        .on_focus(|| emit(ToolbarAction::FocusHandle))
        .on_blur(|| emit(ToolbarAction::BlurHandle))
        .child(icon("grip", p.faint, 14.))
}

fn control_trigger(state: &ToolbarState, p: Palette) -> impl IntoElement {
    let locale = state.ui.locale.as_deref();
    let mode = Mode::of(state);
    let title = label(locale, "panelControl");
    let current = label(locale, mode.label_key());
    let accessible = if mode == Mode::Active {
        title
    } else {
        format!("{title} · {current}")
    };
    let color = if mode == Mode::Active {
        p.text
    } else {
        p.muted
    };
    let content = view()
        .flex_row()
        .items_center()
        .gap(px(6.))
        .child(icon(mode.icon(state), color, 16.))
        .child(text(current).text_size(px(13.)).text_color(rgb(color)))
        .child(icon("chevron", p.faint, 12.));
    trigger(state, Panel::Control, accessible, content, p)
}

fn config_trigger(state: &ToolbarState, p: Palette) -> impl IntoElement {
    let title = label(state.ui.locale.as_deref(), "panelConfig");
    let content = view()
        .flex_row()
        .items_center()
        .gap(px(6.))
        .child(icon("settings", p.muted, 16.))
        .child(
            text(title.clone())
                .text_size(px(13.))
                .text_color(rgb(p.text)),
        )
        .child(icon("chevron", p.faint, 12.));
    trigger(state, Panel::Config, title, content, p)
}

fn monitor_trigger(
    state: &ToolbarState,
    stats: &StreamStats,
    p: Palette,
) -> impl IntoElement + use<> {
    let locale = state.ui.locale.as_deref();
    let quality = stats.quality();
    let rate = frame_rate(stats);
    let title = format!(
        "{} · {} · {rate}",
        label(locale, "panelMonitor"),
        label(locale, quality_key(quality)),
    );
    let content = view()
        .flex_row()
        .items_center()
        .gap(px(6.))
        .child(dot(quality_color(quality, p)))
        .child(
            text(rate)
                // A fixed width keeps the bar from resizing every second.
                .w(px(44.))
                .text_size(px(12.))
                .tabular_nums()
                .text_color(rgb(p.muted)),
        );
    trigger(state, Panel::Monitor, title, content, p)
}

fn divider(p: Palette) -> impl IntoElement {
    view().w(px(1.)).h(px(16.)).mx(px(2.)).bg(rgb(p.border))
}

pub(super) fn bar(state: &ToolbarState, live: Live, p: Palette) -> impl IntoElement + use<> {
    let ui = &state.ui;
    let locale = ui.locale.as_deref();
    let connected = ui.status == Status::Connected;
    let mut bar = view()
        .role(AccessibilityRole::Toolbar)
        .absolute()
        .left(px(state.position.0))
        .top(px(state.position.1))
        // Auto width is constrained by the previous measurement's left inset,
        // making new controls unfold over many frames. Use intrinsic width so
        // positioning cannot constrain the next measurement.
        .app_class(Some("w-max".into()))
        .max_w(px((state.viewport.0 - 24.).max(0.)))
        .flex_row()
        .flex_wrap()
        .items_center()
        .gap(px(2.))
        .p(px(PADDING))
        .rounded(px(12.))
        .border_1()
        .border_color(rgb(p.border))
        .bg(rgb(p.surface))
        .shadow_lg()
        .label(label(locale, "settings"))
        .on_layout(|frame: &Bounds<Points>| {
            emit(ToolbarAction::Measured(
                frame.size.width.0,
                frame.size.height.0,
            ))
        })
        .child(grip(state, p));
    if connected && !state.collapsed {
        let snapshot = state.clone();
        bar = bar
            .child(control_trigger(state, p))
            .child(config_trigger(state, p))
            .child(dynamic(move || {
                monitor_trigger(&snapshot, &live.stats.get(), p)
            }));
    }
    if !state.mobile && ((connected && !state.collapsed) || (!connected && state.fullscreen)) {
        let (key, name) = if state.fullscreen {
            ("exitFullscreen", "minimize")
        } else {
            ("fullscreen", "maximize")
        };
        if connected {
            bar = bar.child(divider(p));
        }
        bar = bar.child(icon_button(
            label(locale, key),
            name,
            ToolbarAction::ToggleFullscreen,
            p,
            false,
        ));
    }
    if connected {
        let (key, name) = if state.collapsed {
            ("expandControls", "expand")
        } else {
            ("collapseControls", "collapse")
        };
        bar = bar.child(icon_button(
            label(locale, key),
            name,
            ToolbarAction::ToggleCollapsed,
            p,
            false,
        ));
    }
    if state.mobile && !connected {
        bar = bar.child(icon_button(
            label(locale, "close"),
            "close",
            ToolbarAction::Close,
            p,
            false,
        ));
    }
    bar
}
