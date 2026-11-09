//! Floating control geometry, independent of the media session.

use crate::nsh_toolbar;
use gpui::{Bounds, Pixels, Point, point, px, size};

pub(crate) const MARGIN: f32 = 12.;

pub(crate) fn grip_bounds(toolbar: Bounds<Pixels>) -> Bounds<Pixels> {
    Bounds::new(
        toolbar.origin + point(px(nsh_toolbar::PADDING + 1.), px(5.)),
        size(px(nsh_toolbar::GRIP_WIDTH), px(28.)),
    )
}

pub(crate) fn clamp_toolbar(
    position: Point<Pixels>,
    content: Bounds<Pixels>,
    toolbar: gpui::Size<Pixels>,
) -> Point<Pixels> {
    let x = f32::from(content.origin.x);
    let y = f32::from(content.origin.y);
    let max_x = (f32::from(content.right()) - f32::from(toolbar.width) - MARGIN).max(x);
    let max_y = (f32::from(content.bottom()) - f32::from(toolbar.height) - MARGIN).max(y);
    point(
        px(f32::from(position.x).clamp((x + MARGIN).min(max_x), max_x)),
        px(f32::from(position.y).clamp((y + MARGIN).min(max_y), max_y)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn toolbar_stays_inside_after_drag_or_window_resize() {
        assert_eq!(
            clamp_toolbar(
                point(px(-30.), px(900.)),
                Bounds::new(Point::default(), size(px(800.), px(600.))),
                size(px(420.), px(56.)),
            ),
            point(px(12.), px(532.))
        );
        assert_eq!(
            clamp_toolbar(
                point(px(100.), px(100.)),
                Bounds::new(Point::default(), size(px(300.), px(40.))),
                size(px(420.), px(56.)),
            ),
            point(px(0.), px(0.))
        );
        assert_eq!(
            clamp_toolbar(
                point(px(0.), px(0.)),
                Bounds::new(point(px(4.), px(36.)), size(px(800.), px(600.))),
                size(px(420.), px(56.)),
            ),
            point(px(16.), px(48.))
        );
    }
}
