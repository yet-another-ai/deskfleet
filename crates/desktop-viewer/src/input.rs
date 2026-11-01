//! Map native window input to the existing physical-key desktop contract.

use deskfleet_input::InputEvent;
use winit::dpi::{PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::keyboard::{KeyCode, PhysicalKey};

use crate::renderer::viewport;

#[derive(Default)]
pub(crate) struct Input {
    pub(crate) enabled: bool,
    cursor: Option<PhysicalPosition<f64>>,
}

impl Input {
    pub(crate) fn event(
        &mut self,
        event: &WindowEvent,
        size: PhysicalSize<u32>,
        video: (u32, u32),
        scale: f64,
    ) -> Option<InputEvent> {
        if !self.enabled {
            return None;
        }
        match event {
            WindowEvent::Focused(false) | WindowEvent::CursorLeft { .. } => {
                self.cursor = None;
                Some(InputEvent::ReleaseAll)
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.cursor = Some(*position);
                point(*position, size, video, false).map(|(x, y)| InputEvent::PointerMove { x, y })
            }
            WindowEvent::MouseInput { state, button, .. } => {
                let button = match button {
                    MouseButton::Left => 0,
                    MouseButton::Middle => 1,
                    MouseButton::Right => 2,
                    MouseButton::Back => 3,
                    MouseButton::Forward => 4,
                    _ => return None,
                };
                let pressed = *state == ElementState::Pressed;
                let (x, y) = point(self.cursor?, size, video, !pressed)?;
                Some(InputEvent::PointerButton {
                    button,
                    pressed,
                    x,
                    y,
                })
            }
            WindowEvent::MouseWheel { delta, .. } => {
                point(self.cursor?, size, video, false)?;
                let (delta_x, delta_y) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => {
                        (-f64::from(*x) * 40., -f64::from(*y) * 40.)
                    }
                    MouseScrollDelta::PixelDelta(p) => (-p.x / scale, -p.y / scale),
                };
                Some(InputEvent::Wheel {
                    delta_x: delta_x.clamp(-10_000., 10_000.),
                    delta_y: delta_y.clamp(-10_000., 10_000.),
                })
            }
            WindowEvent::KeyboardInput {
                event,
                is_synthetic: false,
                ..
            } => {
                let PhysicalKey::Code(key) = event.physical_key else {
                    return None;
                };
                let code = match key {
                    KeyCode::SuperLeft => "MetaLeft".into(),
                    KeyCode::SuperRight => "MetaRight".into(),
                    _ => format!("{key:?}"),
                };
                Some(InputEvent::Key {
                    code,
                    pressed: event.state == ElementState::Pressed,
                    repeat: event.repeat,
                })
            }
            _ => None,
        }
    }
}

fn point(
    position: PhysicalPosition<f64>,
    size: PhysicalSize<u32>,
    video: (u32, u32),
    clamp: bool,
) -> Option<(f64, f64)> {
    if video.0 == 0 || video.1 == 0 {
        return None;
    }
    let (left, top, width, height) = viewport(size, video);
    if width == 0. || height == 0. {
        return None;
    }
    let x = (position.x - left) / width;
    let y = (position.y - top) / height;
    if !clamp && (!(0. ..=1.).contains(&x) || !(0. ..=1.).contains(&y)) {
        return None;
    }
    Some((x.clamp(0., 1.), y.clamp(0., 1.)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letterbox_is_excluded_but_releases_can_clamp() {
        let window = PhysicalSize::new(800, 600);
        let video = (1920, 1080);
        assert_eq!(
            point(PhysicalPosition::new(400., 300.), window, video, false),
            Some((0.5, 0.5))
        );
        assert_eq!(
            point(PhysicalPosition::new(400., 10.), window, video, false),
            None
        );
        assert_eq!(
            point(PhysicalPosition::new(400., 10.), window, video, true),
            Some((0.5, 0.))
        );
    }

    #[test]
    fn focus_loss_releases_remote_controls() {
        let mut input = Input {
            enabled: true,
            ..Default::default()
        };
        assert_eq!(
            input.event(
                &WindowEvent::Focused(false),
                PhysicalSize::new(800, 600),
                (1920, 1080),
                1.
            ),
            Some(InputEvent::ReleaseAll)
        );
        input.enabled = false;
        assert_eq!(
            input.event(
                &WindowEvent::Focused(false),
                PhysicalSize::new(800, 600),
                (1920, 1080),
                1.
            ),
            None
        );
    }
}
