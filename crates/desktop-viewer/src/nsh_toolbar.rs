//! GPUI host for the shared NSH remote desktop controls.

use nsh_platform_gpui::{App, AppOptions, AppView, gpui};
use tokio::sync::watch;

pub(crate) use crate::nsh_controls::{
    BAR_CONTROL_HEIGHT, GRIP_WIDTH, PADDING, PANEL_WIDTH, ToolbarAction, ToolbarState,
};
use crate::nsh_controls::{ControlsBridge, controls_root};

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
        let (state, bridge) = ControlsBridge::new(initial, on_action);
        let options = AppOptions {
            app_id: "io.github.yet_another_ai.deskfleet.viewer".into(),
            transparent: true,
            ..AppOptions::default()
        };
        let view = cx.new(|cx| {
            let view = AppView::new(options, window, cx);
            view.on_error(|message| tracing::error!(%message, "native desktop controls"));
            view.load(App::Rust(controls_root(bridge)));
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
