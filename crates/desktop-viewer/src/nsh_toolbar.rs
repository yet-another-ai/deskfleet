//! The native version of DesktopView's floating controls and stream settings.

use std::sync::Arc;

use nsh_base::{SelectItem, button, checkbox, select, tooltip};
use nsh_core::prelude::*;
use nsh_platform_gpui::{App, AppOptions, AppView, Root, gpui};
use tokio::sync::watch;

use crate::nsh_ui::{self, Palette, icon, label};
use crate::protocol::{Status, UiState};

pub(crate) const PADDING: f32 = 4.;
pub(crate) const GRIP_WIDTH: f32 = 20.;
pub(crate) const PANEL_WIDTH: f32 = 288.;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ToolbarState {
    pub(crate) ui: UiState,
    pub(crate) paused: bool,
    pub(crate) reverse_scroll: bool,
    pub(crate) fullscreen: bool,
    pub(crate) dark: bool,
    pub(crate) settings_open: bool,
    pub(crate) position: (f32, f32),
    pub(crate) toolbar_size: (f32, f32),
    pub(crate) viewport: (f32, f32),
    pub(crate) panel_position: (f32, f32),
    pub(crate) panel_height: f32,
}

impl Default for ToolbarState {
    fn default() -> Self {
        Self {
            ui: UiState::default(),
            paused: false,
            reverse_scroll: false,
            fullscreen: false,
            dark: false,
            settings_open: false,
            position: (12., 12.),
            toolbar_size: (480., 42.),
            viewport: (960., 640.),
            panel_position: (12., 62.),
            panel_height: 176.,
        }
    }
}

impl ToolbarState {
    pub(crate) fn controls_enabled(&self) -> bool {
        self.ui.status == Status::Connected
            && self.ui.control
            && self.ui.input_ready
            && !self.paused
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ToolbarAction {
    ToggleControl,
    ToggleFullscreen,
    ToggleSettings,
    SelectDisplay(u32),
    SetControl(bool),
    SetReverseScroll(bool),
    SecureAttention,
    Reconnect,
    Disconnect,
    Measured(f32, f32),
    PanelMeasured(f32),
    FocusHandle,
    BlurHandle,
    SelectOpen(bool),
}

#[derive(Clone)]
struct Bridge {
    state: watch::Receiver<ToolbarState>,
    action: Arc<dyn Fn(ToolbarAction) + Send + Sync>,
}

pub(crate) struct Toolbar {
    pub(crate) view: gpui::Entity<AppView>,
    state: watch::Sender<ToolbarState>,
}

impl Toolbar {
    pub(crate) fn new(
        window: &mut gpui::Window,
        cx: &mut gpui::App,
        initial: ToolbarState,
        on_action: impl Fn(ToolbarAction) + Send + Sync + 'static,
    ) -> Self {
        use gpui::AppContext as _;
        let (state, receiver) = watch::channel(initial);
        let bridge = Bridge {
            state: receiver,
            action: Arc::new(on_action),
        };
        let mut options = AppOptions {
            app_id: "io.github.yet_another_ai.deskfleet.viewer".into(),
            transparent: true,
            ..AppOptions::default()
        };
        options.context = options.context.with(bridge);
        let view = cx.new(|cx| {
            let view = AppView::new(options, window, cx);
            view.on_error(|message| tracing::error!(%message, "native desktop controls"));
            view.load(App::Rust(Root::of::<ViewerControls>()));
            view
        });
        Self { view, state }
    }

    pub(crate) fn update(&self, state: ToolbarState) {
        self.state.send_if_modified(|current| {
            if *current == state {
                return false;
            }
            *current = state;
            true
        });
    }
}

fn emit(action: ToolbarAction) {
    let bridge = engine_context::<Bridge>().expect("viewer controls bridge is installed");
    (bridge.action)(action);
}

#[component]
fn ViewerControls() -> impl IntoElement {
    let bridge = engine_context::<Bridge>().expect("viewer controls bridge is installed");
    let mut receiver = bridge.state.clone();
    let state = signal(receiver.borrow_and_update().clone());
    spawn(async move {
        while receiver.changed().await.is_ok() {
            state.set(receiver.borrow_and_update().clone());
        }
    });
    view()
        .relative()
        .w_full()
        .h_full()
        .child(dynamic(move || surface(&state.get())))
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
        .h(px(32.))
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
    view()
        .w(px(28.))
        .h(px(28.))
        .tooltip(hint(title.clone(), palette))
        .child(
            button()
                .w(px(28.))
                .h(px(28.))
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
        .h(px(32.))
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
    let p = Palette::new(state.dark);
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
                .w(px(GRIP_WIDTH))
                .h(px(28.))
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
    if connected {
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
    if connected || state.fullscreen {
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
        bar = bar.child(action_button(
            label(
                locale,
                if state.paused {
                    "resumeControl"
                } else {
                    "pauseControl"
                },
            ),
            ToolbarAction::ToggleControl,
            p,
            !ui.input_ready,
        ));
        if ui.secure_attention {
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
        ui.displays.is_empty(),
    ));
    if connected {
        bar = bar.child(disconnect(ui, p));
    }
    root = root.child(bar);
    if state.settings_open {
        root = root.child(settings(state, p));
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
                .h(px(32.))
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
        .absolute()
        .on_layout(|frame: &Bounds<Points>| emit(ToolbarAction::PanelMeasured(frame.size.height.0)))
        .left(px(state.panel_position.0))
        .top(px(state.panel_position.1))
        .w(px(PANEL_WIDTH.min(state.viewport.0 - 24.)))
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
        ));
    if let Some(error) = &ui.settings_error {
        panel = panel.child(
            text(error.clone())
                .text_size(px(13.))
                .text_color(rgb(p.danger)),
        );
    }
    panel
}
