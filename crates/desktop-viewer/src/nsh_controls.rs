//! Shared NSH controls rendered by GPUI, UIKit, and Android native views.

use std::sync::Arc;

use nsh_base::{SelectItem, button, checkbox, select, tooltip};
use nsh_core::prelude::*;
use tokio::sync::watch;

use crate::nsh_ui::{self, Palette, icon, label};
use crate::protocol::{Status, UiState};

#[path = "nsh_controls_state.rs"]
mod state;
pub(crate) use state::{ToolbarAction, ToolbarState};

#[cfg(test)]
#[path = "nsh_controls_tests.rs"]
mod tests;

pub(crate) const PADDING: f32 = 4.;
pub(crate) const GRIP_WIDTH: f32 = 20.;
pub(crate) const PANEL_WIDTH: f32 = 288.;

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
        (
            state,
            Self {
                state: receiver,
                action: Arc::new(on_action),
            },
        )
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
    view()
        .relative()
        .w_full()
        .h_full()
        .child(dynamic(move || surface(&state.get())))
}

fn control_extent(desktop: f32) -> f32 {
    if use_context::<ControlMetrics>().is_some_and(|metrics| metrics.mobile) {
        40.
    } else {
        desktop
    }
}

fn hint(title: String, palette: Palette) -> nsh_base::TooltipElement {
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

fn action_button(
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
        .disabled(disabled)
        .disabled_style(|s| s.opacity(0.4))
        .on_press(move || emit(action))
        .child(text(title).text_size(px(13.)).text_color(rgb(palette.text)))
}

fn icon_button(
    title: String,
    name: &'static str,
    action: ToolbarAction,
    palette: Palette,
    disabled: bool,
) -> impl IntoElement {
    let extent = control_extent(28.);
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

fn disconnect(ui: &UiState, palette: Palette) -> impl IntoElement + use<> {
    button()
        .h(px(control_extent(32.)))
        .px(px(12.))
        .flex_row()
        .items_center()
        .gap(px(6.))
        .rounded(px(6.))
        .border_1()
        .border_color(rgba((palette.danger << 8) | 77))
        .bg(rgba((palette.danger << 8) | 20))
        .hover(move |s| s.bg(rgba((palette.danger << 8) | 35)))
        .on_press(|| emit(ToolbarAction::Disconnect))
        .child(icon("unplug", palette.danger, 14.))
        .child(
            text(label(ui.locale.as_deref(), "disconnect"))
                .text_size(px(13.))
                .text_color(rgb(palette.danger)),
        )
}

fn surface(state: &ToolbarState) -> impl IntoElement + use<> {
    let ui = &state.ui;
    let p = Palette::new(state.dark());
    let locale = ui.locale.as_deref();
    let connected = ui.status == Status::Connected;
    let active = matches!(
        ui.status,
        Status::Connecting | Status::Starting | Status::Connected
    );
    let mut root = view().w_full().h_full().items_center().justify_center();
    if !connected {
        let mut center = view()
            .w(px(420.))
            .max_w(px((state.viewport.0 - 48.).max(0.)))
            .items_center()
            .gap(px(12.))
            .p(px(24.));
        center = center
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
            center = center.child(disconnect(ui, p));
        } else {
            center = center.child(action_button(
                label(locale, "connect"),
                ToolbarAction::Reconnect,
                p,
                false,
            ));
        }
        root = root.child(center);
    }
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
        .gap(px(4.))
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
        .child(
            view()
                .role(AccessibilityRole::Button)
                .on_press(|| emit(ToolbarAction::FocusHandle))
                .w(px(if state.mobile { 44. } else { GRIP_WIDTH }))
                .h(px(if state.mobile { 40. } else { 28. }))
                .flex_shrink_0()
                .rounded(px(6.))
                .items_center()
                .justify_center()
                .label(label(locale, "moveControls"))
                .tooltip(hint(label(locale, "moveControls"), p))
                .hover(move |s| s.bg(rgb(p.hover)))
                .on_focus(|| emit(ToolbarAction::FocusHandle))
                .on_blur(|| emit(ToolbarAction::BlurHandle))
                .child(icon("grip", p.faint, 14.)),
        );
    if state.mobile {
        bar = bar.child(icon_button(
            label(
                locale,
                if state.collapsed {
                    "expandControls"
                } else {
                    "collapseControls"
                },
            ),
            if state.collapsed {
                "expand"
            } else {
                "collapse"
            },
            ToolbarAction::ToggleCollapsed,
            p,
            false,
        ));
        if state.collapsed {
            return root.child(bar);
        }
    }
    if connected && !state.mobile {
        bar = bar.child(
            view()
                .flex_row()
                .items_center()
                .gap(px(6.))
                .px(px(8.))
                .child(
                    view()
                        .w(px(6.))
                        .h(px(6.))
                        .rounded(px(3.))
                        .bg(rgb(p.success)),
                )
                .child(
                    text(nsh_ui::status(ui))
                        .text_size(px(13.))
                        .text_color(rgb(p.muted)),
                ),
        );
    }
    if !state.mobile && (connected || state.fullscreen) {
        bar = bar.child(icon_button(
            label(
                locale,
                if state.fullscreen {
                    "exitFullscreen"
                } else {
                    "fullscreen"
                },
            ),
            if state.fullscreen {
                "minimize"
            } else {
                "maximize"
            },
            ToolbarAction::ToggleFullscreen,
            p,
            false,
        ));
    }
    if connected && ui.control {
        let pause_title = label(
            locale,
            if state.paused {
                "resumeControl"
            } else {
                "pauseControl"
            },
        );
        if state.mobile {
            bar = bar.child(icon_button(
                pause_title,
                if state.paused { "play" } else { "pause" },
                ToolbarAction::ToggleControl,
                p,
                !ui.input_ready,
            ));
            bar = bar.child(icon_button(
                label(
                    locale,
                    if state.relative_mouse {
                        "relativeMouse"
                    } else {
                        "absoluteMouse"
                    },
                ),
                if state.relative_mouse {
                    "trackpad"
                } else {
                    "pointer"
                },
                ToolbarAction::ToggleMouseMode,
                p,
                !state.controls_enabled(),
            ));
            bar = bar.child(icon_button(
                label(
                    locale,
                    if state.keyboard_open {
                        "hideKeyboard"
                    } else {
                        "systemKeyboard"
                    },
                ),
                "keyboard",
                ToolbarAction::ToggleKeyboard,
                p,
                !state.controls_enabled(),
            ));
        } else {
            bar = bar.child(action_button(
                pause_title,
                ToolbarAction::ToggleControl,
                p,
                !ui.input_ready,
            ));
        }
        bar = bar.child(icon_button(
            label(locale, "hackerKeyboard"),
            "terminal",
            ToolbarAction::ToggleHackerKeyboard,
            p,
            !state.controls_enabled(),
        ));
        if ui.secure_attention && !state.mobile {
            bar = bar.child(action_button(
                label(locale, "sendSecureAttention"),
                ToolbarAction::SecureAttention,
                p,
                !state.controls_enabled(),
            ));
        }
    }
    bar = bar.child(icon_button(
        label(locale, "settings"),
        "settings",
        ToolbarAction::ToggleSettings,
        p,
        ui.displays.is_empty() && !state.mobile,
    ));
    if connected {
        if state.mobile {
            bar = bar.child(icon_button(
                label(locale, "disconnect"),
                "unplug",
                ToolbarAction::Disconnect,
                p,
                false,
            ));
        } else {
            bar = bar.child(disconnect(ui, p));
        }
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
    root = root.child(bar);
    if state.settings_open {
        root = root.child(settings(state, p));
    }
    if state.hacker_open {
        root = root.child(crate::nsh_keyboard::panel(state, p));
    }
    root
}

fn settings_checkbox(
    checked: bool,
    title: String,
    action: fn(bool) -> ToolbarAction,
    palette: Palette,
) -> impl IntoElement {
    checkbox()
        .min_h(px(control_extent(32.)))
        .checked(checked)
        .flex_row()
        .items_center()
        .gap(px(8.))
        .indicator_class(format!(
            "w-4 h-4 rounded border border-[#{:06x}] items-center justify-center",
            palette.border
        ))
        .indicator(if checked {
            icon("check", palette.accent, 16.).into_element()
        } else {
            view().into_element()
        })
        .on_change(move |enabled: &bool| emit(action(*enabled)))
        .child(text(title).text_size(px(13.)).text_color(rgb(palette.text)))
}

fn settings(state: &ToolbarState, p: Palette) -> impl IntoElement + use<> {
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
    let dropdown = select()
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
                .h(px(if state.mobile { 40. } else { 32. }))
                .flex_row()
                .items_center()
                .justify_between()
                .px(px(8.))
                .rounded(px(6.))
                .border_1()
                .border_color(rgb(p.border))
                .bg(rgb(p.control))
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
        });
    let mut panel = view()
        .p(px(12.))
        .gap(px(12.))
        .rounded(px(8.))
        .border_1()
        .border_color(rgb(p.border))
        .bg(rgb(p.surface))
        .shadow_lg()
        .label(label(locale, "settings"))
        .child(
            view()
                .flex_row()
                .items_center()
                .justify_between()
                .child(
                    text(label(locale, "settings"))
                        .text_size(px(13.))
                        .text_color(rgb(p.text)),
                )
                .child(icon_button(
                    label(locale, "hideSettings"),
                    "close",
                    ToolbarAction::ToggleSettings,
                    p,
                    false,
                )),
        )
        .child(
            view()
                .gap(px(6.))
                .child(
                    text(label(locale, "display"))
                        .text_size(px(13.))
                        .text_color(rgb(p.muted)),
                )
                .child(dropdown),
        )
        .child(
            text(label(locale, "codecStatus").replace("{codec}", nsh_ui::codec_label(ui.codec)))
                .text_size(px(13.))
                .text_color(rgb(p.muted)),
        )
        .child(settings_checkbox(
            ui.control,
            label(locale, "control"),
            ToolbarAction::SetControl,
            p,
        ))
        .child(settings_checkbox(
            state.reverse_scroll,
            label(locale, "reverseScroll"),
            ToolbarAction::SetReverseScroll,
            p,
        ))
        .child(settings_checkbox(
            state.clipboard_sharing,
            label(locale, "clipboard"),
            ToolbarAction::SetClipboardSharing,
            p,
        ));
    if state.mobile {
        panel = panel.child(settings_checkbox(
            state.dragging,
            label(locale, "dragMouse"),
            |_| ToolbarAction::ToggleDrag,
            p,
        ));
        panel = panel.child(action_button(
            label(locale, "syncClipboard"),
            ToolbarAction::SyncClipboard,
            p,
            !state.controls_enabled(),
        ));
        if ui.platform.as_deref() != Some("darwin") {
            panel = panel.child(settings_checkbox(
                state.paste_shift,
                label(locale, "terminalPaste"),
                ToolbarAction::SetPasteShift,
                p,
            ));
        }
        if ui.secure_attention {
            panel = panel.child(action_button(
                label(locale, "sendSecureAttention"),
                ToolbarAction::SecureAttention,
                p,
                !state.controls_enabled(),
            ));
        }
        panel = panel.child(action_button(
            label(
                locale,
                if state.fullscreen {
                    "exitFullscreen"
                } else {
                    "fullscreen"
                },
            ),
            ToolbarAction::ToggleFullscreen,
            p,
            false,
        ));
        panel = panel.child(action_button(
            label(locale, "close"),
            ToolbarAction::Close,
            p,
            false,
        ));
    }
    if let Some(error) = &ui.settings_error {
        panel = panel.child(
            text(error.clone())
                .text_size(px(13.))
                .text_color(rgb(p.danger)),
        );
    }
    scroll()
        .absolute()
        .left(px(state.panel_position.0))
        .top(px(state.panel_position.1))
        .w(px(PANEL_WIDTH.min((state.viewport.0 - 24.).max(0.))))
        .max_h(px((state.viewport.1 - 24.).max(0.)))
        .on_layout(|frame: &Bounds<Points>| emit(ToolbarAction::PanelMeasured(frame.size.height.0)))
        .child(panel)
}
