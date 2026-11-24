//! Geometry shared by the NSH mobile viewer and its native event hit tests.

use crate::nsh_controls::{BAR_CONTROL_HEIGHT, GRIP_WIDTH, PADDING, PANEL_WIDTH, ToolbarState};
use crate::protocol::Status;

type Point = (f32, f32);

#[derive(Clone, Copy, Default)]
struct Rect {
    origin: Point,
    size: Point,
}

impl Rect {
    fn contains(self, x: f32, y: f32) -> bool {
        x >= self.origin.0
            && x < self.origin.0 + self.size.0
            && y >= self.origin.1
            && y < self.origin.1 + self.size.1
    }
}

pub(crate) struct MobileLayout {
    toolbar: Rect,
    panel: Rect,
    keyboard: Rect,
    panel_height: f32,
    keyboard_height: f32,
    modal: bool,
    select_open: bool,
}

impl Default for MobileLayout {
    fn default() -> Self {
        Self {
            toolbar: Rect {
                origin: (12., 12.),
                size: (320., 100.),
            },
            panel: Rect::default(),
            keyboard: Rect::default(),
            panel_height: 320.,
            keyboard_height: 260.,
            modal: true,
            select_open: false,
        }
    }
}

impl MobileLayout {
    // A fractional measurement can come back slightly different after NSH applies
    // a position. Ignore sub-half-point noise in its layout feedback loop.
    pub(crate) fn measure_toolbar(&mut self, width: f32, height: f32) {
        let (old_width, old_height) = self.toolbar.size;
        if (width - old_width).abs() >= 0.5 || (height - old_height).abs() >= 0.5 {
            self.toolbar.size = (width, height);
        }
    }

    pub(crate) fn measure_panel(&mut self, height: f32) {
        if (height - self.panel_height).abs() >= 0.5 {
            self.panel_height = height;
        }
    }

    pub(crate) fn measure_keyboard(&mut self, height: f32) {
        if (height - self.keyboard_height).abs() >= 0.5 {
            self.keyboard_height = height;
        }
    }

    pub(crate) fn position(&self) -> Point {
        self.toolbar.origin
    }

    pub(crate) fn move_to(&mut self, x: f32, y: f32) {
        self.toolbar.origin = (x, y);
    }

    /// The input viewport is the native overlay bounds. NSH positions are in
    /// its coordinate space, while size constraints use the unobscured viewport.
    pub(crate) fn layout(&mut self, state: &mut ToolbarState, insets: [f32; 4], select_open: bool) {
        let [left, top, right, bottom] = insets;
        let width = (state.viewport.0 - left - right).max(0.);
        let height = (state.viewport.1 - top - bottom).max(0.);
        state.viewport = (width, height);
        let inner_width = (width - 24.).max(0.);
        let inner_height = (height - 24.).max(0.);
        let min_x = left + 12.;
        let min_y = top + 12.;
        let bottom = min_y + inner_height;
        let toolbar_height = self.toolbar.size.1;
        let keyboard_limit = (inner_height - toolbar_height - 8.).clamp(0., 400.);
        let keyboard_width = inner_width.min(520.);
        let keyboard_height = keyboard_limit.min(self.keyboard_height);
        self.keyboard = if state.hacker_open {
            Rect {
                origin: (
                    left + (width - keyboard_width) / 2.,
                    bottom - keyboard_height,
                ),
                size: (keyboard_width, keyboard_height),
            }
        } else {
            Rect::default()
        };
        state.keyboard_position = self.keyboard.origin;
        state.keyboard_size = (keyboard_width, keyboard_limit);

        let available_bottom = if state.hacker_open {
            self.keyboard.origin.1 - 8.
        } else {
            bottom
        };
        let clamp_x = |x: f32, w: f32| x.clamp(min_x, min_x + (inner_width - w).max(0.));
        let (x, y) = self.toolbar.origin;
        self.toolbar.origin = (
            clamp_x(x, self.toolbar.size.0),
            y.clamp(min_y, (available_bottom - toolbar_height).max(min_y)),
        );
        state.position = self.position();
        state.toolbar_size = self.toolbar.size;

        let panel_width = PANEL_WIDTH.min(inner_width);
        let panel_height = self.panel_height.min(inner_height);
        let below = state.position.1 + toolbar_height + 8.;
        let panel_y = if below + panel_height <= available_bottom {
            below
        } else {
            state.position.1 - panel_height - 8.
        };
        let panel_position = (
            clamp_x(state.position.0, panel_width),
            panel_y.clamp(min_y, (available_bottom - panel_height).max(min_y)),
        );
        state.panel_position = panel_position;
        state.panel_height = panel_height;
        self.panel =
            if state.panel.is_some() && !state.collapsed && state.ui.status == Status::Connected {
                Rect {
                    origin: panel_position,
                    size: (panel_width, panel_height),
                }
            } else {
                Rect::default()
            };
        self.select_open = select_open;
        self.modal = select_open || state.ui.status != Status::Connected;
    }

    pub(crate) fn hit_test(&self, x: f32, y: f32) -> bool {
        self.modal
            || self.toolbar.contains(x, y)
            || self.panel.contains(x, y)
            || self.keyboard.contains(x, y)
    }

    pub(crate) fn hit_grip(&self, x: f32, y: f32) -> bool {
        // Cover the grip's outer edge while stopping before the next button.
        let (left, top) = self.position();
        let inset = PADDING + 1.;
        !self.select_open
            && Rect {
                origin: (left, top),
                size: (inset + GRIP_WIDTH, BAR_CONTROL_HEIGHT + inset * 2.),
            }
            .contains(x, y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nsh_controls::Panel;

    #[test]
    fn hit_regions_follow_rendered_controls_through_drag_resize_and_ime() {
        let mut layout = MobileLayout::default();
        let mut state = ToolbarState::default();
        state.ui.status = Status::Connected;
        state.viewport = (800., 720.);
        state.hacker_open = true;
        state.panel = Some(Panel::Control);
        layout.measure_toolbar(220., 48.);
        layout.measure_panel(150.);
        layout.measure_keyboard(220.);
        layout.move_to(800., 800.);
        layout.layout(&mut state, [30., 10., 10., 200.], false);
        assert_eq!(state.position, (558., 232.));
        assert!(layout.hit_grip(565., 240.));
        assert!(layout.hit_test(620., 180.));
        assert!(layout.hit_test(400., 500.));
        assert!(!layout.hit_test(45., 220.));
        state.hacker_open = false;
        state.panel = None;
        state.viewport = (500., 600.);
        layout.layout(&mut state, [0.; 4], false);
        assert!(layout.hit_grip(state.position.0 + 2., state.position.1 + 2.));
        assert!(!layout.hit_grip(
            state.position.0 + PADDING + 1. + GRIP_WIDTH + 1.,
            state.position.1 + 10.,
        ));
        assert!(!layout.hit_test(400., 500.));
        state.viewport = (500., 600.);
        layout.layout(&mut state, [0.; 4], true);
        assert!(layout.hit_test(45., 220.));
        assert!(!layout.hit_grip(state.position.0 + 6., state.position.1 + 6.));
    }
}
