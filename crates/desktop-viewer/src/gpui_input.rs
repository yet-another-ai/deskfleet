//! GPUI pointer input. Physical keyboard capture lives in `physical_input`.
//! Local overlays consume events before this adapter.

use deskfleet_input::InputEvent;
use gpui::{
    Bounds, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, NavigationDirection, Pixels,
    Point, ScrollWheelEvent, px,
};

#[derive(Default)]
pub(crate) struct Input {
    enabled: bool,
    buttons: u8,
}

impl Input {
    pub(crate) fn set_enabled(&mut self, enabled: bool) -> Option<InputEvent> {
        let was_enabled = self.enabled;
        self.enabled = enabled;
        (was_enabled && !enabled).then(|| self.release())
    }

    /// Clear remote state before local UI takes input, even while keys are held.
    pub(crate) fn release(&mut self) -> InputEvent {
        self.buttons = 0;
        InputEvent::ReleaseAll
    }

    pub(crate) fn mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        video: Bounds<Pixels>,
    ) -> Vec<InputEvent> {
        if !self.enabled {
            return Vec::new();
        }
        let Some((x, y)) = normalized_point(event.position, video, false) else {
            return Vec::new();
        };
        vec![InputEvent::PointerMove { x, y }]
    }

    pub(crate) fn mouse_down(
        &mut self,
        event: &MouseDownEvent,
        video: Bounds<Pixels>,
    ) -> Vec<InputEvent> {
        if !self.enabled {
            return Vec::new();
        }
        let Some((x, y)) = normalized_point(event.position, video, false) else {
            return Vec::new();
        };
        let button = mouse_button(event.button);
        self.buttons |= 1 << button;
        vec![InputEvent::PointerButton {
            button,
            pressed: true,
            x,
            y,
        }]
    }

    pub(crate) fn mouse_up(
        &mut self,
        event: &MouseUpEvent,
        video: Bounds<Pixels>,
    ) -> Vec<InputEvent> {
        let button = mouse_button(event.button);
        if !self.enabled || self.buttons & (1 << button) == 0 {
            return Vec::new();
        }
        self.buttons &= !(1 << button);
        // A drag may end in the letterbox. Release its remote button there too.
        let Some((x, y)) = normalized_point(event.position, video, true) else {
            return vec![self.release()];
        };
        vec![InputEvent::PointerButton {
            button,
            pressed: false,
            x,
            y,
        }]
    }

    pub(crate) fn scroll(
        &mut self,
        event: &ScrollWheelEvent,
        video: Bounds<Pixels>,
    ) -> Vec<InputEvent> {
        if !self.enabled || normalized_point(event.position, video, false).is_none() {
            return Vec::new();
        }
        let delta = event.delta.pixel_delta(px(40.));
        let (x, y) = (f64::from(delta.x), f64::from(delta.y));
        vec![InputEvent::Wheel {
            delta_x: (-x).clamp(-10_000., 10_000.),
            delta_y: (-y).clamp(-10_000., 10_000.),
        }]
    }
}

fn mouse_button(button: MouseButton) -> u8 {
    match button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
        MouseButton::Navigate(NavigationDirection::Back) => 3,
        MouseButton::Navigate(NavigationDirection::Forward) => 4,
    }
}

fn normalized_point(
    position: Point<Pixels>,
    video: Bounds<Pixels>,
    clamp: bool,
) -> Option<(f64, f64)> {
    let width = f64::from(video.size.width);
    let height = f64::from(video.size.height);
    if width <= 0. || height <= 0. {
        return None;
    }
    let x = f64::from(position.x - video.origin.x) / width;
    let y = f64::from(position.y - video.origin.y) / height;
    if !clamp && (!(0. ..=1.).contains(&x) || !(0. ..=1.).contains(&y)) {
        return None;
    }
    Some((x.clamp(0., 1.), y.clamp(0., 1.)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{ScrollDelta, point, size};

    fn active() -> Input {
        let mut input = Input::default();
        input.set_enabled(true);
        input
    }

    fn video() -> Bounds<Pixels> {
        // A 16:9 image letterboxed in an 800×600 logical-pixel window.
        Bounds::new(point(px(0.), px(75.)), size(px(800.), px(450.)))
    }

    #[test]
    fn release_clears_buttons_before_local_ui_takes_input() {
        let mut input = active();
        let press = MouseDownEvent {
            position: point(px(400.), px(300.)),
            ..Default::default()
        };
        input.mouse_down(&press, video());
        assert_eq!(input.release(), InputEvent::ReleaseAll);
        assert!(
            input
                .mouse_up(
                    &MouseUpEvent {
                        position: press.position,
                        ..Default::default()
                    },
                    video()
                )
                .is_empty()
        );
        assert_eq!(input.set_enabled(false), Some(InputEvent::ReleaseAll));
        assert!(input.mouse_down(&press, video()).is_empty());
        assert_eq!(input.set_enabled(false), None);
    }

    #[test]
    fn letterbox_rejects_presses_but_releases_a_remote_drag() {
        let mut input = active();
        assert!(
            input
                .mouse_down(
                    &MouseDownEvent {
                        position: point(px(400.), px(10.)),
                        ..Default::default()
                    },
                    video()
                )
                .is_empty()
        );
        assert_eq!(
            input.mouse_move(
                &MouseMoveEvent {
                    position: point(px(400.), px(300.)),
                    ..Default::default()
                },
                video()
            ),
            vec![InputEvent::PointerMove { x: 0.5, y: 0.5 }]
        );
        assert_eq!(
            input.mouse_down(
                &MouseDownEvent {
                    position: point(px(400.), px(300.)),
                    ..Default::default()
                },
                video()
            ),
            vec![InputEvent::PointerButton {
                button: 0,
                pressed: true,
                x: 0.5,
                y: 0.5
            }]
        );
        assert_eq!(
            input.mouse_up(
                &MouseUpEvent {
                    position: point(px(400.), px(10.)),
                    ..Default::default()
                },
                video()
            ),
            vec![InputEvent::PointerButton {
                button: 0,
                pressed: false,
                x: 0.5,
                y: 0.
            }]
        );
    }

    #[test]
    fn wheel_uses_logical_pixels_and_remote_scroll_direction() {
        let mut input = active();
        assert_eq!(
            input.scroll(
                &ScrollWheelEvent {
                    position: point(px(400.), px(300.)),
                    delta: ScrollDelta::Pixels(point(px(2.), px(-12.))),
                    ..Default::default()
                },
                video()
            ),
            vec![InputEvent::Wheel {
                delta_x: -2.,
                delta_y: 12.
            }]
        );
        assert_eq!(
            input.scroll(
                &ScrollWheelEvent {
                    position: point(px(400.), px(300.)),
                    delta: ScrollDelta::Lines(point(1., -2.)),
                    ..Default::default()
                },
                video()
            ),
            vec![InputEvent::Wheel {
                delta_x: -40.,
                delta_y: 80.
            }]
        );
    }
}
