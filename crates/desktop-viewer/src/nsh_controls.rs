//! Shared NSH controls rendered by GPUI, UIKit, and Android native views.

use std::sync::Arc;

use nsh_core::prelude::*;
use tokio::sync::watch;

use crate::nsh_ui::{self, Palette, icon, label};
use crate::protocol::Status;
use crate::stream_stats::{self, StreamStats};
use crate::zoom;

#[path = "nsh_controls_bar.rs"]
mod bar;
#[path = "nsh_controls_config.rs"]
mod config;
#[path = "nsh_controls_input.rs"]
mod input;
#[path = "nsh_controls_monitor.rs"]
mod monitor;
#[path = "nsh_controls_state.rs"]
mod state;
#[path = "nsh_controls_widgets.rs"]
mod widgets;
pub(crate) use state::{Panel, ToolbarAction, ToolbarState};
pub(crate) use widgets::PANEL_WIDTH;

#[cfg(test)]
#[path = "nsh_controls_tests.rs"]
mod tests;

pub(crate) const PADDING: f32 = 4.;
pub(crate) const GRIP_WIDTH: f32 = 20.;
pub(crate) const MOBILE_GRIP_WIDTH: f32 = 44.;
pub(crate) const MOBILE_CONTROL_HEIGHT: f32 = 40.;

#[derive(Clone)]
pub(crate) struct ControlsBridge {
    state: watch::Receiver<ToolbarState>,
    action: Arc<dyn Fn(ToolbarAction) + Send + Sync>,
}

impl ControlsBridge {
    pub(crate) fn new(
        initial: ToolbarState,
        on_action: impl Fn(ToolbarAction) + Send + Sync + 'static,
    ) -> (watch::Sender<ToolbarState>, Self) {
        let (state, receiver) = watch::channel(initial);
        (state, Self::from_receiver(receiver, on_action))
    }

    pub(crate) fn from_receiver(
        state: watch::Receiver<ToolbarState>,
        on_action: impl Fn(ToolbarAction) + Send + Sync + 'static,
    ) -> Self {
        Self {
            state,
            action: Arc::new(on_action),
        }
    }
}

// Rust-only props keep each embedded surface's bridge independent. Mobile
// backends do not expose GPUI's EngineContext configuration API.
impl PartialEq for ControlsBridge {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.action, &other.action)
    }
}

impl Props for ControlsBridge {
    fn spec(_: &mut nsh_core::element::TsTypes) -> Vec<nsh_core::element::PropSpec> {
        vec![]
    }
    fn initial() -> Self {
        Self::new(ToolbarState::default(), |_| {}).1
    }
    fn set(
        &mut self,
        name: &str,
        value: Option<nsh_core::element::AnyValue>,
    ) -> Result<bool, nsh_core::element::PropError> {
        ().set(name, value)
    }
    fn set_slot(&mut self, _: &str, _: Option<Slot>) -> bool {
        false
    }
    fn set_children(&mut self, _: Children) -> bool {
        false
    }
}

pub(crate) fn controls_root(bridge: ControlsBridge) -> nsh_core::element::Root {
    nsh_core::element::Root::new::<ViewerControls>(move || bridge.clone())
}

pub(crate) fn emit(action: ToolbarAction) {
    let bridge = use_context::<ControlsBridge>().expect("viewer controls bridge is installed");
    (bridge.action)(action);
}

pub(crate) struct ViewerControls;
impl Component for ViewerControls {
    type Props = ControlsBridge;
    type Event = NoEvent;
    fn view(bridge: ControlsBridge, _: Scope<NoEvent>) -> impl IntoElement {
        controls(bridge)
    }
}

#[derive(Clone, Copy)]
struct ControlMetrics {
    mobile: bool,
}

/// Values that change faster than host snapshots. Only the parts that show
/// them re-render, so an open dropdown survives each stats sample.
#[derive(Clone, Copy)]
struct Live {
    stats: Signal<StreamStats>,
    zoom: Signal<f64>,
}

/// Mirrors a process-wide watch channel into a signal for this root.
fn follow<T: Clone + PartialEq + 'static>(mut receiver: watch::Receiver<T>) -> Signal<T> {
    let value = signal(receiver.borrow_and_update().clone());
    spawn(async move {
        while receiver.changed().await.is_ok() {
            // Drop the watch read guard before signal.set synchronously renders.
            let next = receiver.borrow_and_update().clone();
            value.set(next);
        }
    });
    value
}

fn controls(bridge: ControlsBridge) -> impl IntoElement {
    provide_context(bridge.clone());
    let mut receiver = bridge.state.clone();
    let initial = receiver.borrow_and_update().clone();
    // The host's platform is fixed for this root's lifetime. Rendering must not
    // borrow the watch channel again while a host update waits for its writer.
    provide_context(ControlMetrics {
        mobile: initial.mobile,
    });
    let state = signal(initial);
    spawn(async move {
        while receiver.changed().await.is_ok() {
            // Drop the watch read guard before signal.set synchronously renders.
            let next = receiver.borrow_and_update().clone();
            state.set(next);
        }
    });
    let live = Live {
        stats: follow(stream_stats::subscribe()),
        zoom: follow(zoom::subscribe()),
    };
    view()
        .relative()
        .w_full()
        .h_full()
        .child(dynamic(move || surface(&state.get(), live)))
}

fn control_extent(desktop: f32) -> f32 {
    if use_context::<ControlMetrics>().is_some_and(|metrics| metrics.mobile) {
        MOBILE_CONTROL_HEIGHT
    } else {
        desktop
    }
}

/// The centred card shown until the stream is connected.
fn connection(state: &ToolbarState, p: Palette) -> impl IntoElement + use<> {
    let ui = &state.ui;
    let locale = ui.locale.as_deref();
    let active = matches!(ui.status, Status::Connecting | Status::Starting);
    let mut center = view()
        .w(px(420.))
        .max_w(px((state.viewport.0 - 48.).max(0.)))
        .items_center()
        .gap(px(12.))
        .p(px(24.))
        .child(icon(
            "monitor",
            if ui.status == Status::Error {
                p.danger
            } else {
                p.accent
            },
            28.,
        ))
        .child(
            text(nsh_ui::status(ui))
                .text_size(px(14.))
                .text_color(rgb(p.text)),
        );
    if let Some(error) = &ui.error {
        center = center.child(
            text(error.clone())
                .text_size(px(13.))
                .text_color(rgb(p.muted)),
        );
    }
    if active {
        center.child(widgets::danger_button(
            label(locale, "disconnect"),
            ToolbarAction::Disconnect,
            p,
        ))
    } else {
        center.child(widgets::action_button(
            label(locale, "connect"),
            ToolbarAction::Reconnect,
            p,
            false,
        ))
    }
}

fn surface(state: &ToolbarState, live: Live) -> impl IntoElement + use<> {
    let p = Palette::new(state.dark());
    let connected = state.ui.status == Status::Connected;
    let mut root = view().w_full().h_full().items_center().justify_center();
    if !connected {
        root = root.child(connection(state, p));
    }
    root = root.child(bar::bar(state, live, p));
    // Hosts keep at most one panel open; a stale panel never outlives the
    // connection or a collapsed mobile bar.
    match state.panel {
        Some(_) if !connected || (state.mobile && state.collapsed) => {}
        Some(Panel::Control) => root = root.child(input::panel(state, live, p)),
        Some(Panel::Config) => root = root.child(config::panel(state, p)),
        Some(Panel::Monitor) => root = root.child(monitor::panel(state, live, p)),
        None => {}
    }
    if state.hacker_open {
        root = root.child(crate::nsh_keyboard::panel(state, p));
    }
    root
}
