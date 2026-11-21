//! Local pinch zoom for mobile viewers. Zoom changes presentation only: the
//! remote display keeps its size, and touch input maps through the zoomed rect.
//! Desktop hosts only read the published scale.
#![cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]

use std::sync::LazyLock;

use tokio::sync::watch;

/// A presentation rectangle in surface pixels: left, top, width, height.
pub(crate) type Rect = (f64, f64, f64, f64);

pub(crate) const MAX_SCALE: f64 = 5.;
/// Relative-mode cursor reveal keeps this much surface around the pointer.
const REVEAL_MARGIN: f64 = 48.;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Zoom {
    scale: f64,
    /// Normalized video point presented at the surface centre.
    center: (f64, f64),
    /// The previous focal point of an active pinch, in surface pixels.
    focal: Option<(f64, f64)>,
}

impl Default for Zoom {
    fn default() -> Self {
        Self {
            scale: 1.,
            center: (0.5, 0.5),
            focal: None,
        }
    }
}

impl Zoom {
    pub(crate) fn scale(&self) -> f64 {
        self.scale
    }

    /// `fit` is the contain-fitted video rect. A zoomed axis that is larger
    /// than the surface never exposes letterbox at either edge.
    pub(crate) fn rect(&self, surface: (f64, f64), fit: Rect) -> Rect {
        let (width, height) = (fit.2 * self.scale, fit.3 * self.scale);
        (
            axis(surface.0, width, self.center.0),
            axis(surface.1, height, self.center.1),
            width,
            height,
        )
    }

    /// Applies one incremental pinch step. The video point under the previous
    /// focal point follows the fingers, so a two-finger drag also pans.
    /// `limit` is the GPU's largest viewport extent.
    pub(crate) fn pinch(
        &mut self,
        focal: (f64, f64),
        ratio: f64,
        surface: (f64, f64),
        fit: Rect,
        limit: f64,
    ) {
        if fit.2 <= 0. || fit.3 <= 0. || !ratio.is_finite() || ratio <= 0. {
            return;
        }
        if !focal.0.is_finite() || !focal.1.is_finite() {
            return;
        }
        let before = self.rect(surface, fit);
        let previous = self.focal.unwrap_or(focal);
        let point = (
            (previous.0 - before.0) / before.2,
            (previous.1 - before.1) / before.3,
        );
        let largest = (limit / fit.2.max(fit.3)).max(1.);
        self.scale = (self.scale * ratio).clamp(1., MAX_SCALE.min(largest));
        let (width, height) = (fit.2 * self.scale, fit.3 * self.scale);
        let left = focal.0 - point.0 * width;
        let top = focal.1 - point.1 * height;
        self.settle(surface, fit, (left, top));
        self.focal = Some(focal);
    }

    pub(crate) fn end(&mut self) {
        self.focal = None;
    }

    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }

    /// Pans just enough to keep a normalized video point on screen.
    pub(crate) fn reveal(&mut self, point: (f64, f64), surface: (f64, f64), fit: Rect) {
        if self.scale <= 1. || fit.2 <= 0. || fit.3 <= 0. {
            return;
        }
        let (left, top, width, height) = self.rect(surface, fit);
        let dx = shift(left + point.0 * width, surface.0);
        let dy = shift(top + point.1 * height, surface.1);
        if dx != 0. || dy != 0. {
            self.settle(surface, fit, (left + dx, top + dy));
        }
    }

    /// Stores a requested origin as the clamped canonical centre.
    fn settle(&mut self, surface: (f64, f64), fit: Rect, origin: (f64, f64)) {
        let (width, height) = (fit.2 * self.scale, fit.3 * self.scale);
        self.center = (
            (surface.0 / 2. - origin.0) / width,
            (surface.1 / 2. - origin.1) / height,
        );
        let (left, top, ..) = self.rect(surface, fit);
        self.center = (
            (surface.0 / 2. - left) / width,
            (surface.1 / 2. - top) / height,
        );
    }
}

fn axis(surface: f64, extent: f64, center: f64) -> f64 {
    if extent <= surface {
        (surface - extent) / 2.
    } else {
        (surface / 2. - center * extent).clamp(surface - extent, 0.)
    }
}

fn shift(position: f64, surface: f64) -> f64 {
    let margin = REVEAL_MARGIN.min(surface / 2.);
    if position < margin {
        margin - position
    } else if position > surface - margin {
        surface - margin - position
    } else {
        0.
    }
}

static SCALE: LazyLock<watch::Sender<f64>> = LazyLock::new(|| watch::channel(1.).0);

/// The presented zoom factor, shown by the controls' Control panel.
pub(crate) fn subscribe() -> watch::Receiver<f64> {
    SCALE.subscribe()
}

pub(crate) fn publish(scale: f64) {
    SCALE.send_if_modified(|current| {
        let changed = (*current - scale).abs() > f64::EPSILON;
        *current = scale;
        changed
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const SURFACE: (f64, f64) = (800., 600.);
    // 1920x1080 video contained by an 800x600 surface.
    const FIT: Rect = (0., 75., 800., 450.);

    fn close(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1e-6, "{actual} != {expected}");
    }

    #[test]
    fn unzoomed_view_is_the_fitted_rect() {
        assert_eq!(Zoom::default().rect(SURFACE, FIT), FIT);
    }

    #[test]
    fn pinch_keeps_the_point_under_the_fingers() {
        let mut zoom = Zoom::default();
        let focal = (600., 300.);
        zoom.pinch(focal, 2., SURFACE, FIT, 8192.);
        let (left, top, width, height) = zoom.rect(SURFACE, FIT);
        close(width, 1600.);
        close(height, 900.);
        // Video point (0.75, 0.5) stays at the focal point.
        close(left + 0.75 * width, focal.0);
        close(top + 0.5 * height, focal.1);
    }

    #[test]
    fn moving_the_focal_point_pans_and_edges_never_show_letterbox() {
        let mut zoom = Zoom::default();
        zoom.pinch((400., 300.), 2., SURFACE, FIT, 8192.);
        zoom.pinch((1400., 300.), 1., SURFACE, FIT, 8192.);
        let (left, top, ..) = zoom.rect(SURFACE, FIT);
        close(left, 0.);
        close(top, -150.);
        zoom.end();
        zoom.pinch((400., 300.), 0.01, SURFACE, FIT, 8192.);
        assert_eq!(zoom.scale(), 1.);
        assert_eq!(zoom.rect(SURFACE, FIT), FIT);
    }

    #[test]
    fn scale_respects_both_the_product_and_gpu_limits() {
        let mut zoom = Zoom::default();
        zoom.pinch((400., 300.), 100., SURFACE, FIT, 16_384.);
        assert_eq!(zoom.scale(), MAX_SCALE);
        zoom.reset();
        zoom.pinch((400., 300.), 100., SURFACE, FIT, 2048.);
        close(zoom.scale(), 2.56);
        zoom.pinch((400., 300.), f64::NAN, SURFACE, FIT, 2048.);
        close(zoom.scale(), 2.56);
    }

    #[test]
    fn reveal_follows_a_relative_cursor_off_screen() {
        let mut zoom = Zoom::default();
        zoom.pinch((400., 300.), 2., SURFACE, FIT, 8192.);
        zoom.reveal((0.95, 0.5), SURFACE, FIT);
        let (left, _, width, _) = zoom.rect(SURFACE, FIT);
        close(left + 0.95 * width, SURFACE.0 - REVEAL_MARGIN);
        let unchanged = zoom;
        zoom.reveal((0.9, 0.5), SURFACE, FIT);
        assert_eq!(zoom, unchanged);
    }
}
