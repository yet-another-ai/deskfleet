//! Native mobile gestures mapped into the rendered video's display coordinates.

use deskfleet_input::InputEvent;

pub(crate) struct TouchInput {
    cursor: (f64, f64),
}

impl Default for TouchInput {
    fn default() -> Self {
        Self { cursor: (0.5, 0.5) }
    }
}

impl TouchInput {
    /// Kinds 0..6 are absolute move/drag/click/right-click/scroll/release.
    /// Kinds 8..13 are relative move/click/right-click/drag/scroll; 14 resets
    /// the virtual cursor when switching modes. Deltas are surface pixels.
    pub(crate) fn events(
        &mut self,
        kind: i32,
        position: (f64, f64),
        delta: (f64, f64),
        viewport: (f64, f64, f64, f64),
    ) -> Vec<InputEvent> {
        if kind == 6 || kind == 14 {
            if kind == 14 {
                self.cursor = (0.5, 0.5);
            }
            return vec![InputEvent::ReleaseAll];
        }
        let (_, _, width, height) = viewport;
        if width <= 0. || height <= 0. {
            return Vec::new();
        }
        if kind == 5 || kind == 13 {
            if !delta.0.is_finite() || !delta.1.is_finite() {
                return Vec::new();
            }
            if kind == 5 {
                let Some(point) = normalized_point(position, viewport, false) else {
                    return Vec::new();
                };
                self.cursor = point;
            }
            let (x, y) = self.cursor;
            return vec![
                InputEvent::PointerMove { x, y },
                InputEvent::Wheel {
                    delta_x: delta.0.clamp(-10_000., 10_000.),
                    delta_y: delta.1.clamp(-10_000., 10_000.),
                },
            ];
        }
        if kind == 8 {
            if !delta.0.is_finite() || !delta.1.is_finite() {
                return Vec::new();
            }
            self.cursor.0 = (self.cursor.0 + delta.0 / width).clamp(0., 1.);
            self.cursor.1 = (self.cursor.1 + delta.1 / height).clamp(0., 1.);
        } else if (0..=4).contains(&kind) {
            let Some(point) = normalized_point(position, viewport, kind == 2) else {
                return Vec::new();
            };
            self.cursor = point;
        }
        let (x, y) = self.cursor;
        let button = |button, pressed| InputEvent::PointerButton {
            button,
            pressed,
            x,
            y,
        };
        match kind {
            0 | 8 => vec![InputEvent::PointerMove { x, y }],
            1 | 11 => vec![InputEvent::PointerMove { x, y }, button(0, true)],
            2 | 12 => vec![button(0, false)],
            3 | 4 | 9 | 10 => {
                let which = if kind == 4 || kind == 10 { 2 } else { 0 };
                vec![
                    InputEvent::PointerMove { x, y },
                    button(which, true),
                    button(which, false),
                ]
            }
            _ => Vec::new(),
        }
    }
}

fn normalized_point(
    position: (f64, f64),
    viewport: (f64, f64, f64, f64),
    clamp: bool,
) -> Option<(f64, f64)> {
    let (left, top, width, height) = viewport;
    let x = (position.0 - left) / width;
    let y = (position.1 - top) / height;
    if !x.is_finite()
        || !y.is_finite()
        || (!clamp && (!(0. ..=1.).contains(&x) || !(0. ..=1.).contains(&y)))
    {
        return None;
    }
    Some((x.clamp(0., 1.), y.clamp(0., 1.)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 1920x1080 video contained by an 800x600 surface.
    const VIEWPORT: (f64, f64, f64, f64) = (0., 75., 800., 450.);

    #[test]
    fn letterbox_is_excluded_but_drag_releases_can_clamp() {
        let mut input = TouchInput::default();
        assert!(input.events(3, (400., 10.), (0., 0.), VIEWPORT).is_empty());
        assert_eq!(
            input.events(0, (400., 300.), (0., 0.), VIEWPORT),
            [InputEvent::PointerMove { x: 0.5, y: 0.5 }]
        );
        assert_eq!(
            input.events(2, (400., 10.), (0., 0.), VIEWPORT),
            [InputEvent::PointerButton {
                button: 0,
                pressed: false,
                x: 0.5,
                y: 0.
            }]
        );
    }

    #[test]
    fn relative_gestures_reuse_cursor_and_scale_by_video_viewport() {
        let mut input = TouchInput::default();
        assert_eq!(
            input.events(8, (0., 0.), (200., 112.5), VIEWPORT),
            [InputEvent::PointerMove { x: 0.75, y: 0.75 }]
        );
        let click = input.events(9, (10., 20.), (0., 0.), VIEWPORT);
        assert_eq!(
            click[1],
            InputEvent::PointerButton {
                button: 0,
                pressed: true,
                x: 0.75,
                y: 0.75
            }
        );
        assert_eq!(
            input.events(8, (0., 0.), (800., -900.), VIEWPORT),
            [InputEvent::PointerMove { x: 1., y: 0. }]
        );
        assert_eq!(
            input.events(14, (0., 0.), (0., 0.), VIEWPORT),
            [InputEvent::ReleaseAll]
        );
        assert_eq!(
            input.events(11, (0., 0.), (0., 0.), VIEWPORT)[1],
            InputEvent::PointerButton {
                button: 0,
                pressed: true,
                x: 0.5,
                y: 0.5
            }
        );
        assert_eq!(
            input.events(12, (0., 0.), (0., 0.), VIEWPORT),
            [InputEvent::PointerButton {
                button: 0,
                pressed: false,
                x: 0.5,
                y: 0.5
            }]
        );
    }

    #[test]
    fn scrolling_targets_absolute_touch_or_relative_cursor() {
        let mut input = TouchInput::default();
        assert_eq!(
            input.events(13, (0., 0.), (0., 50.), VIEWPORT),
            [
                InputEvent::PointerMove { x: 0.5, y: 0.5 },
                InputEvent::Wheel {
                    delta_x: 0.,
                    delta_y: 50.
                }
            ]
        );
        assert_eq!(
            input.events(5, (600., 412.5), (0., 50.), VIEWPORT),
            [
                InputEvent::PointerMove { x: 0.75, y: 0.75 },
                InputEvent::Wheel {
                    delta_x: 0.,
                    delta_y: 50.
                }
            ]
        );
        assert!(input.events(5, (400., 10.), (0., 50.), VIEWPORT).is_empty());
        assert_eq!(
            input.events(13, (400., 10.), (0., 50.), VIEWPORT)[0],
            InputEvent::PointerMove { x: 0.75, y: 0.75 }
        );
        assert!(
            input
                .events(8, (0., 0.), (f64::NAN, 10.), VIEWPORT)
                .is_empty()
        );
        assert_eq!(
            input.events(9, (0., 0.), (0., 0.), VIEWPORT)[0],
            InputEvent::PointerMove { x: 0.75, y: 0.75 }
        );
    }
}
