//! Per-view NSH state shared by the Android and iOS hosts.

use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use crate::mobile_layout::MobileLayout;
use crate::nsh_controls::{ControlsBridge, Panel, ToolbarAction, ToolbarState};
use crate::protocol::Status;

pub(crate) struct MobileOverlay {
    layout: MobileLayout,
    input: ToolbarState,
    insets: [f32; 4],
    select_open: bool,
    panel: Option<Panel>,
    collapsed: bool,
    state: watch::Sender<ToolbarState>,
}

impl MobileOverlay {
    pub(crate) fn attach(
        input: ToolbarState,
        insets: [f32; 4],
        on_action: impl Fn(ToolbarAction) + Send + Sync + 'static,
    ) -> (Arc<Mutex<Self>>, ControlsBridge) {
        let (state, receiver) = watch::channel(input.clone());
        let mut overlay = Self {
            layout: MobileLayout::default(),
            input,
            insets,
            select_open: false,
            panel: None,
            collapsed: false,
            state,
        };
        overlay.publish();
        let overlay = Arc::new(Mutex::new(overlay));
        let actions = Arc::clone(&overlay);
        let bridge = ControlsBridge::from_receiver(receiver, move |action| {
            actions
                .lock()
                .expect("viewer layout lock")
                .apply_action(action);
            if !matches!(
                action,
                ToolbarAction::Measured(..)
                    | ToolbarAction::PanelMeasured(_)
                    | ToolbarAction::KeyboardMeasured(..)
            ) {
                // Platform side effects can re-enter the host. Release the lock first.
                on_action(action);
            }
        });
        (overlay, bridge)
    }

    pub(crate) fn update(&mut self, input: ToolbarState, insets: [f32; 4]) {
        if input.ui.status != Status::Connected {
            self.close_panel();
        }
        self.input = input;
        self.insets = insets;
        self.publish();
    }

    pub(crate) fn drag(&mut self, dx: f32, dy: f32) {
        let (x, y) = self.layout.position();
        self.layout.move_to(x + dx, y + dy);
        self.publish();
    }

    pub(crate) fn hit(&self, x: f32, y: f32, grip: bool) -> bool {
        if grip {
            self.layout.hit_grip(x, y)
        } else {
            self.layout.hit_test(x, y)
        }
    }

    pub(crate) fn owns_focus(&self) -> bool {
        self.panel.is_some() || self.select_open
    }

    #[cfg(any(target_os = "android", test))]
    pub(crate) fn dismiss_panel(&mut self) -> bool {
        if !self.owns_focus() {
            return false;
        }
        self.close_panel();
        self.publish();
        true
    }

    fn publish(&mut self) {
        let mut next = self.input.clone();
        next.mobile = true;
        next.panel = self.panel;
        next.collapsed = self.collapsed;
        self.layout.layout(&mut next, self.insets, self.select_open);
        self.state.send_if_modified(|state| {
            if *state == next {
                return false;
            }
            *state = next;
            true
        });
    }

    fn apply_action(&mut self, action: ToolbarAction) {
        match action {
            ToolbarAction::Measured(w, h) => self.layout.measure_toolbar(w, h),
            ToolbarAction::PanelMeasured(h) => self.layout.measure_panel(h),
            ToolbarAction::KeyboardMeasured(_, h) => self.layout.measure_keyboard(h),
            ToolbarAction::ToggleCollapsed => {
                self.collapsed = !self.collapsed;
                self.close_panel();
            }
            ToolbarAction::TogglePanel(next) => {
                self.panel = if self.panel == Some(next) {
                    None
                } else {
                    Some(next)
                };
                self.select_open = false;
            }
            ToolbarAction::ToggleHackerKeyboard
            | ToolbarAction::SelectDisplay(_)
            | ToolbarAction::Reconnect
            | ToolbarAction::Disconnect => self.close_panel(),
            ToolbarAction::SelectOpen(open) => self.select_open = open,
            _ => return,
        }
        self.publish();
    }

    fn close_panel(&mut self) {
        self.select_open = false;
        self.panel = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_updates_preserve_panels_and_back_releases_the_surface() {
        let mut input = ToolbarState::default();
        input.ui.status = Status::Connected;
        let (overlay, _bridge) = MobileOverlay::attach(input.clone(), [0.; 4], |_| {});
        let mut overlay = overlay.lock().unwrap();
        overlay.apply_action(ToolbarAction::TogglePanel(Panel::Control));
        overlay.apply_action(ToolbarAction::SelectOpen(true));
        overlay.update(input.clone(), [0.; 4]);
        assert_eq!(overlay.state.borrow().panel, Some(Panel::Control));
        assert!(overlay.hit(900., 600., false));
        assert!(overlay.dismiss_panel());
        assert!(!overlay.hit(900., 600., false));
        assert!(!overlay.dismiss_panel());

        overlay.drag(30., 12.);
        assert!(overlay.hit(50., 32., true));
        overlay.apply_action(ToolbarAction::TogglePanel(Panel::Config));
        input.ui.status = Status::Disconnected;
        overlay.update(input, [0.; 4]);
        assert!(!overlay.owns_focus());
        assert!(overlay.hit(900., 600., false));
    }
}
