use std::time::{Duration, Instant};

use crate::{AudioFrame, CaptureConfig, CaptureError, Display, Frame, NativeSurface, PixelFormat};

pub(crate) fn displays() -> Result<Vec<Display>, CaptureError> {
    deskfleet_wayland::sources()
        .map(|sources| {
            sources
                .into_iter()
                .map(|source| Display {
                    id: source.id,
                    // Portal dimensions are logical. Captured Frame dimensions come
                    // from negotiated PipeWire pixels and supersede these for encoding.
                    width: source.width,
                    height: source.height,
                    refresh_rate_hz: 0.0,
                })
                .collect()
        })
        .map_err(|error| CaptureError::Platform(error.to_string()))
}

pub(crate) struct LinuxStream {
    capture: deskfleet_linux_media::Capture,
    source_id: u32,
    frame_period: Duration,
}

impl LinuxStream {
    pub(crate) fn new(display: &Display, config: &CaptureConfig) -> Result<Self, CaptureError> {
        if config.capture_audio {
            return Err(CaptureError::Unsupported("Linux system audio capture"));
        }
        if !config.show_cursor {
            return Err(CaptureError::Unsupported(
                "hiding the authorized Wayland cursor",
            ));
        }
        if config.width.is_some() || config.height.is_some() {
            return Err(CaptureError::Unsupported("resizing Wayland capture"));
        }
        let (remote, source) = deskfleet_wayland::open_pipewire(display.id)
            .map_err(|error| CaptureError::Platform(error.to_string()))?;
        let capture = deskfleet_linux_media::Capture::new(
            remote,
            source.node_id,
            source.pipewire_serial,
            config.fps,
        )
        .map_err(map_error)?;
        Ok(Self {
            capture,
            source_id: display.id,
            frame_period: Duration::from_secs_f64(1.0 / config.fps),
        })
    }

    pub(crate) fn start(&self) -> Result<(), CaptureError> {
        self.ensure_source()
    }

    fn ensure_source(&self) -> Result<(), CaptureError> {
        let active = deskfleet_wayland::sources()
            .map_err(|error| CaptureError::Platform(error.to_string()))?
            .iter()
            .any(|source| source.id == self.source_id);
        if !active {
            let _ = self.capture.stop();
            return Err(CaptureError::StreamEnded);
        }
        Ok(())
    }

    pub(crate) fn stop(&self) -> Result<(), CaptureError> {
        self.capture.stop().map_err(map_error)
    }

    pub(crate) fn poll_frame(&self) -> Result<Option<Frame>, CaptureError> {
        self.next_frame_timeout(self.frame_period.min(Duration::from_millis(100)))
    }

    pub(crate) fn next_frame(&self) -> Result<Frame, CaptureError> {
        loop {
            if let Some(frame) = self.poll_frame()? {
                return Ok(frame);
            }
        }
    }

    pub(crate) fn try_next_frame(&self) -> Result<Option<Frame>, CaptureError> {
        self.next_frame_timeout(Duration::ZERO)
    }

    pub(crate) fn next_frame_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Option<Frame>, CaptureError> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or(CaptureError::InvalidConfig("capture timeout is too large"))?;
        let frame = loop {
            self.ensure_source()?;
            // Bound each read so portal closure/revocation is observed even while
            // the compositor stops producing video (for example when locked).
            let remaining = deadline.saturating_duration_since(Instant::now());
            let frame = self
                .capture
                .next_frame(remaining.min(Duration::from_millis(100)))
                .map_err(map_error)?;
            self.ensure_source()?;
            if frame.is_some() || Instant::now() >= deadline {
                break frame;
            }
        };
        frame
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

    pub(crate) fn next_audio_frame(&self) -> Result<AudioFrame, CaptureError> {
        Err(CaptureError::Unsupported("Linux system audio capture"))
    }

    pub(crate) fn try_next_audio_frame(&self) -> Result<Option<AudioFrame>, CaptureError> {
        Err(CaptureError::Unsupported("Linux system audio capture"))
    }

    pub(crate) fn has_audio(&self) -> bool {
        false
    }
}

fn map_error(error: deskfleet_linux_media::Error) -> CaptureError {
    match error {
        deskfleet_linux_media::Error::Ended => CaptureError::StreamEnded,
        error => CaptureError::Platform(error.to_string()),
    }
}
