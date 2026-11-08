//! Window chrome when a Linux compositor requires client-side decorations.
//!
//! The host handles these hit regions before forwarding input to the desktop.
//! Native title bars remain responsible for chrome on macOS and Windows.

use gpui::{
    AnyElement, Bounds, Decorations, InteractiveElement, IntoElement, ParentElement, Pixels, Point,
    ResizeEdge, Size, Styled, Window, WindowControls, div, point, px, rgb, size,
};

const HEADER_HEIGHT: f32 = 32.;
const RESIZE_WIDTH: f32 = 6.;
const BUTTON_WIDTH: f32 = 40.;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChromeHit {
    Move,
    Minimize,
    Maximize,
    Close,
    Resize(ResizeEdge),
}

pub(crate) struct Chrome {
    viewport: Size<Pixels>,
    header: Option<Bounds<Pixels>>,
    inset: Pixels,
    maximized: bool,
    controls: WindowControls,
}

impl Chrome {
    pub(crate) fn for_window(window: &Window) -> Self {
        let viewport = window.viewport_size();
        let client = cfg!(target_os = "linux")
            && matches!(window.window_decorations(), Decorations::Client { .. })
            && !window.is_fullscreen();
        let maximized = window.is_maximized();
        let inset = px(if client && !maximized {
            RESIZE_WIDTH
        } else {
            0.
        });
        let header = client.then(|| {
            Bounds::new(
                point(inset, inset),
                size((viewport.width - inset * 2.).max(px(0.)), px(HEADER_HEIGHT)),
            )
        });
        Self {
            viewport,
            header,
            inset,
            maximized,
            controls: window.window_controls(),
        }
    }

    /// The video and floating toolbar share these absolute window coordinates.
    pub(crate) fn content_bounds(&self) -> Bounds<Pixels> {
        let top = self.header.map_or(px(0.), |header| header.bottom());
        Bounds::new(
            point(self.inset, top),
            size(
                (self.viewport.width - self.inset * 2.).max(px(0.)),
                (self.viewport.height - top - self.inset).max(px(0.)),
            ),
        )
    }

    /// Returns `None` for native chrome, fullscreen, and the desktop content.
    pub(crate) fn hit_test(&self, position: Point<Pixels>) -> Option<ChromeHit> {
        let header = self.header?;
        if self.inset > px(0.) {
            for (bounds, edge) in self.resize_regions() {
                if bounds.contains(&position) {
                    return Some(ChromeHit::Resize(edge));
                }
            }
        }
        if !header.contains(&position) {
            return None;
        }
        let mut right = header.right();
        for hit in self.buttons() {
            right -= px(BUTTON_WIDTH);
            if position.x >= right {
                return Some(hit);
            }
        }
        Some(ChromeHit::Move)
    }

    /// Visual chrome only: the viewer owns actions and the close handshake.
    pub(crate) fn render(&self, title: &str) -> AnyElement {
        let Some(header) = self.header else {
            return div().absolute().size(px(0.)).into_any_element();
        };
        let mut buttons = div().flex().items_center().h_full();
        for hit in self.buttons().rev() {
            let (id, glyph) = match hit {
                ChromeHit::Minimize => ("minimize", "—"),
                ChromeHit::Maximize => ("maximize", if self.maximized { "▣" } else { "□" }),
                ChromeHit::Close => ("close", "×"),
                _ => continue,
            };
            buttons = buttons.child(
                div()
                    .id(id)
                    .flex()
                    .items_center()
                    .justify_center()
                    .w(px(BUTTON_WIDTH))
                    .h_full()
                    .text_size(px(16.))
                    .cursor_pointer()
                    .hover(move |style| {
                        style.bg(rgb(if hit == ChromeHit::Close {
                            0xb91c1c
                        } else {
                            0x374151
                        }))
                    })
                    .child(glyph),
            );
        }
        let mut root = div()
            .absolute()
            .left_0()
            .top_0()
            .w(self.viewport.width)
            .h(self.viewport.height)
            .child(
                div()
                    .absolute()
                    .left(header.origin.x)
                    .top(header.origin.y)
                    .w(header.size.width)
                    .h(header.size.height)
                    .flex()
                    .items_center()
                    .bg(rgb(0x1f2937))
                    .text_color(rgb(0xe5e7eb))
                    .font_family("sans-serif")
                    .text_size(px(13.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .px(px(12.))
                            .truncate()
                            .child(title.to_owned()),
                    )
                    .child(buttons),
            );
        if self.inset > px(0.) {
            for (index, (bounds, edge)) in self.resize_regions().into_iter().enumerate() {
                let cursor = match edge {
                    ResizeEdge::Top | ResizeEdge::Bottom => gpui::CursorStyle::ResizeUpDown,
                    ResizeEdge::Left | ResizeEdge::Right => gpui::CursorStyle::ResizeLeftRight,
                    ResizeEdge::TopLeft | ResizeEdge::BottomRight => {
                        gpui::CursorStyle::ResizeUpLeftDownRight
                    }
                    ResizeEdge::TopRight | ResizeEdge::BottomLeft => {
                        gpui::CursorStyle::ResizeUpRightDownLeft
                    }
                };
                root = root.child(
                    div()
                        .id(("desktop-resize-edge", index))
                        .absolute()
                        .left(bounds.origin.x)
                        .top(bounds.origin.y)
                        .w(bounds.size.width)
                        .h(bounds.size.height)
                        .bg(rgb(0x1f2937))
                        .cursor(cursor),
                );
            }
        }
        root.into_any_element()
    }

    /// Ordered from the right edge inward; render reverses the order.
    fn buttons(&self) -> impl DoubleEndedIterator<Item = ChromeHit> {
        [
            Some(ChromeHit::Close),
            self.controls.maximize.then_some(ChromeHit::Maximize),
            self.controls.minimize.then_some(ChromeHit::Minimize),
        ]
        .into_iter()
        .flatten()
    }

    fn resize_regions(&self) -> [(Bounds<Pixels>, ResizeEdge); 8] {
        let e = self.inset;
        let width = self.viewport.width;
        let height = self.viewport.height;
        let middle_width = (width - e * 2.).max(px(0.));
        let middle_height = (height - e * 2.).max(px(0.));
        let bounds = |x, y, width, height| Bounds::new(point(x, y), size(width, height));
        [
            (bounds(px(0.), px(0.), e, e), ResizeEdge::TopLeft),
            (bounds(width - e, px(0.), e, e), ResizeEdge::TopRight),
            (bounds(px(0.), height - e, e, e), ResizeEdge::BottomLeft),
            (bounds(width - e, height - e, e, e), ResizeEdge::BottomRight),
            (bounds(e, px(0.), middle_width, e), ResizeEdge::Top),
            (bounds(e, height - e, middle_width, e), ResizeEdge::Bottom),
            (bounds(px(0.), e, e, middle_height), ResizeEdge::Left),
            (bounds(width - e, e, e, middle_height), ResizeEdge::Right),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrome_hit_regions_exclude_the_remote_desktop() {
        let chrome = Chrome {
            viewport: size(px(800.), px(600.)),
            header: Some(Bounds::new(point(px(6.), px(6.)), size(px(788.), px(32.)))),
            inset: px(6.),
            maximized: false,
            controls: WindowControls::default(),
        };

        assert_eq!(
            chrome.content_bounds(),
            Bounds::new(point(px(6.), px(38.)), size(px(788.), px(556.))),
        );
        assert_eq!(chrome.hit_test(point(px(400.), px(300.))), None);
        assert_eq!(
            chrome.hit_test(point(px(100.), px(22.))),
            Some(ChromeHit::Move)
        );
        assert_eq!(
            chrome.hit_test(point(px(694.), px(22.))),
            Some(ChromeHit::Minimize)
        );
        assert_eq!(
            chrome.hit_test(point(px(734.), px(22.))),
            Some(ChromeHit::Maximize)
        );
        assert_eq!(
            chrome.hit_test(point(px(774.), px(22.))),
            Some(ChromeHit::Close)
        );
        assert_eq!(
            chrome.hit_test(point(px(400.), px(3.))),
            Some(ChromeHit::Resize(ResizeEdge::Top)),
        );
        assert_eq!(
            chrome.hit_test(point(px(3.), px(3.))),
            Some(ChromeHit::Resize(ResizeEdge::TopLeft)),
        );
    }
}
