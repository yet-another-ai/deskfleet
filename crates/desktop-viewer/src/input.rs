//! Android touch coordinates normalized to the rendered video viewport.

use crate::renderer::{PhysicalSize, viewport};

pub(crate) fn normalized_point(
    position: (f64, f64),
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
    let x = (position.0 - left) / width;
    let y = (position.1 - top) / height;
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
            normalized_point((400., 300.), window, video, false),
            Some((0.5, 0.5))
        );
        assert_eq!(normalized_point((400., 10.), window, video, false), None);
        assert_eq!(
            normalized_point((400., 10.), window, video, true),
            Some((0.5, 0.))
        );
    }
}
