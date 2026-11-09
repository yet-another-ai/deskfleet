//! Decoded pixels enter GPUI's GPU image path without crossing NSH's engine.
//! GPUI owns the swapchain and frame callbacks; these are submission statistics,
//! not Wayland presentation feedback or end-to-end latency measurements.

use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{App, Bounds, Corners, Pixels, RenderImage, Window, point, px, size};
use serde_json::json;

use crate::{Error, protocol, session::Frames};

pub(crate) struct Video {
    frames: Frames,
    image: Option<Arc<RenderImage>>,
    pending: bool,
    submitted: u64,
    ready_age_ms: f64,
    last_stats: Instant,
    pub(crate) dimensions: (u32, u32),
}

impl Video {
    pub(crate) fn new(frames: Frames) -> Self {
        Self {
            frames,
            image: None,
            pending: false,
            submitted: 0,
            ready_age_ms: 0.,
            last_stats: Instant::now(),
            dimensions: (0, 0),
        }
    }

    /// Select only one candidate for a GPUI frame. A selected image is never
    /// replaced until paint has submitted it to the scene.
    pub(crate) fn prepare(&mut self, window: &mut Window) -> Result<(), Error> {
        if self.pending {
            return Ok(());
        }
        let frame = self
            .frames
            .lock()
            .map_err(|_| "decoded queue poisoned")?
            .pop();
        let Some(mut frame) = frame else {
            return Ok(());
        };
        self.ready_age_ms = frame.ready_at.elapsed().as_secs_f64() * 1000.;
        self.dimensions = (frame.width, frame.height);
        // RenderImage expects BGRA. Reuse the owned decoder buffer for conversion.
        for pixel in frame.pixels.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
        }
        let buffer = image::RgbaImage::from_raw(frame.width, frame.height, frame.pixels)
            .ok_or("invalid decoded video dimensions")?;
        let image = Arc::new(RenderImage::new(vec![image::Frame::new(buffer)]));
        if let Some(previous) = self.image.replace(image) {
            // Keep the previous atlas entry alive until this frame has rendered.
            window.on_next_frame(move |window, cx| cx.drop_image(previous, Some(window)));
        }
        self.pending = true;
        Ok(())
    }

    pub(crate) fn paint(
        &mut self,
        bounds: Bounds<Pixels>,
        window: &mut Window,
    ) -> Result<(), Error> {
        if let Some(image) = &self.image {
            let video = video_bounds(bounds, self.dimensions);
            window
                .paint_image(bounds, video, Corners::default(), image.clone(), 0, false)
                .map_err(|error| error.to_string())?;
            if self.pending {
                self.submitted += 1;
                self.pending = false;
            }
        }
        self.stats()
    }

    pub(crate) fn has_candidate(&self) -> bool {
        self.frames.lock().is_ok_and(|frames| !frames.is_empty())
    }

    fn stats(&mut self) -> Result<(), Error> {
        if self.last_stats.elapsed() < Duration::from_secs(1) {
            return Ok(());
        }
        let frames = self.frames.lock().map_err(|_| "decoded queue poisoned")?;
        protocol::emit(json!({
            "type": "stats", "decodedFrames": frames.received,
            "submittedFrames": self.submitted, "droppedFrames": frames.dropped,
            "width": self.dimensions.0, "height": self.dimensions.1,
            "maxCandidates": frames.max_candidates, "readyToSubmitMs": self.ready_age_ms,
            "presentationMode": "gpui", "presentedCommits": null,
        }))?;
        self.last_stats = Instant::now();
        Ok(())
    }

    pub(crate) fn clear(&mut self, window: &mut Window, cx: &mut App) {
        if let Some(image) = self.image.take() {
            cx.drop_image(image, Some(window));
        }
        self.dimensions = (0, 0);
        self.pending = false;
        self.submitted = 0;
        self.ready_age_ms = 0.;
    }
}

pub(crate) fn video_bounds(bounds: Bounds<Pixels>, dimensions: (u32, u32)) -> Bounds<Pixels> {
    if dimensions.0 == 0 || dimensions.1 == 0 {
        return Bounds::new(bounds.origin, size(px(0.), px(0.)));
    }
    let scale = (f32::from(bounds.size.width) / dimensions.0 as f32)
        .min(f32::from(bounds.size.height) / dimensions.1 as f32);
    let width = px(dimensions.0 as f32 * scale);
    let height = px(dimensions.1 as f32 * scale);
    Bounds::new(
        point(
            bounds.origin.x + (bounds.size.width - width) / 2.,
            bounds.origin.y + (bounds.size.height - height) / 2.,
        ),
        size(width, height),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_is_centered_and_preserves_aspect_ratio() {
        let bounds = Bounds::new(point(px(10.), px(20.)), size(px(800.), px(600.)));
        assert_eq!(
            video_bounds(bounds, (1920, 1080)),
            Bounds::new(point(px(10.), px(95.)), size(px(800.), px(450.)))
        );
        assert_eq!(video_bounds(bounds, (0, 0)).size, size(px(0.), px(0.)));
    }
}
