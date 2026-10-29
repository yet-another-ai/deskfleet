use std::time::Duration;

use crate::{CaptureConfig, CaptureError, Display, Frame, NativeSurface, PixelFormat};

pub(super) fn displays() -> Result<Vec<Display>, CaptureError> {
    deskfleet_x11::sources()
        .map(|sources| {
            sources
                .into_iter()
                .map(|source| Display {
                    id: source.id,
                    width: source.width,
                    height: source.height,
                    refresh_rate_hz: source.refresh_rate_hz,
                })
                .collect()
        })
        .map_err(map_error)
}

pub(crate) struct X11Stream {
    capture: deskfleet_x11::Capture,
    frame_period: Duration,
}

impl X11Stream {
    pub(super) fn new(display: &Display, config: &CaptureConfig) -> Result<Self, CaptureError> {
        if config.capture_audio {
            return Err(CaptureError::Unsupported("Linux system audio capture"));
        }
        if config.width.is_some() || config.height.is_some() {
            return Err(CaptureError::Unsupported("resizing X11 capture"));
        }
        let capture = deskfleet_x11::Capture::new(display.id, config.fps, config.show_cursor)
            .map_err(map_error)?;
        Ok(Self {
            capture,
            frame_period: Duration::from_secs_f64(1.0 / config.fps),
        })
    }

    pub(super) fn start(&self) -> Result<(), CaptureError> {
        self.capture.start().map_err(map_error)
    }

    pub(super) fn stop(&self) -> Result<(), CaptureError> {
        self.capture.stop().map_err(map_error)
    }

    pub(super) fn poll_frame(&self) -> Result<Option<Frame>, CaptureError> {
        self.next_frame_timeout(self.frame_period.min(Duration::from_millis(100)))
    }

    pub(super) fn next_frame(&self) -> Result<Frame, CaptureError> {
        loop {
            if let Some(frame) = self.poll_frame()? {
                return Ok(frame);
            }
        }
    }

    pub(super) fn next_frame_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Option<Frame>, CaptureError> {
        self.capture
            .next_frame(timeout)
            .map_err(map_error)?
            .map(|frame| {
                let stride = frame
                    .width
                    .checked_mul(4)
                    .ok_or(CaptureError::InvalidConfig("captured row is too large"))?;
                Ok(Frame::new(
                    frame.width,
                    frame.height,
                    stride,
                    PixelFormat::Bgra8,
                    frame.timestamp_ns,
                    NativeSurface {
                        inner: frame.pixels,
                    },
                ))
            })
            .transpose()
    }
}

fn map_error(error: deskfleet_x11::Error) -> CaptureError {
    match error {
        deskfleet_x11::Error::StaleSource | deskfleet_x11::Error::Stopped => {
            CaptureError::StreamEnded
        }
        error => CaptureError::Platform(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires a running X11 server; run under Xvfb"]
    fn x11_stream_delivers_bgra_and_discards_frames_after_stop() {
        let display = displays().expect("X11 displays").remove(0);
        let config = CaptureConfig {
            fps: 30.0,
            show_cursor: false,
            ..CaptureConfig::default()
        };
        let stream = X11Stream::new(&display, &config).expect("create X11 capture");
        stream.start().expect("start X11 capture");
        let frame = stream
            .next_frame_timeout(Duration::from_secs(5))
            .expect("read frame")
            .expect("frame before deadline");
        assert_eq!(frame.width, display.width);
        assert_eq!(frame.height, display.height);
        assert_eq!(frame.pixel_format, PixelFormat::Bgra8);
        assert_eq!(frame.stride, display.width * 4);
        assert_eq!(
            frame.copy_pixels().expect("copy frame").len(),
            (frame.stride * frame.height) as usize
        );
        stream.stop().expect("stop X11 capture");
        assert!(matches!(
            stream.next_frame_timeout(Duration::ZERO),
            Err(CaptureError::StreamEnded)
        ));
    }
}
