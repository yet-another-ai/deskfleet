//! Screen capture and native surfaces for DeskFleet.
//!
//! Ported from dsh0416/desk-fleet (e4b963274b4afae8a7b8065d9efe5c6770bf9339),
//! rust/capture. Capture starts only when explicitly requested.

mod audio;
mod backend;
mod error;
mod frame;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
pub mod surface;
mod types;
#[cfg(target_os = "windows")]
mod windows;

pub use audio::AudioFrame;
pub use error::CaptureError;
pub use frame::{Frame, PixelFormat};
pub use surface::NativeSurface;
pub use types::{CaptureConfig, Display};

#[cfg(target_os = "windows")]
pub use windows::create_d3d11_device as create_d3d11_device_for_display;

/// Check screen recording access without prompting or starting capture.
///
/// Returns `None` on platforms without an upfront permission request.
#[must_use]
pub fn check_screen_capture_access() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        Some(objc2_core_graphics::CGPreflightScreenCaptureAccess())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Request screen and system-audio recording access for the current process.
///
/// On macOS, this prompts only when access has not yet been determined and
/// returns whether access is granted. Other platforms return `None` without
/// prompting. This does not enumerate displays or start capture.
#[must_use]
pub fn request_screen_capture_access() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        use objc2_core_graphics::{CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess};

        Some(CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// A handle to an active screen capture stream.
pub struct CaptureStream {
    inner: backend::PlatformStream,
}

impl CaptureStream {
    /// Start capturing frames.
    pub fn start(&self) -> Result<(), CaptureError> {
        self.inner.start()
    }

    /// Stop capturing frames.
    pub fn stop(&self) -> Result<(), CaptureError> {
        self.inner.stop()
    }

    /// Block until the next frame is available, or return an error if the stream ended.
    pub fn next_frame(&self) -> Result<Frame, CaptureError> {
        self.inner.next_frame()
    }

    /// Try to get the next frame without blocking.
    pub fn try_next_frame(&self) -> Result<Option<Frame>, CaptureError> {
        self.inner.try_next_frame()
    }

    /// Poll for a single frame from the capture source.
    ///
    /// On macOS the stream is started automatically on the first call
    /// (`ScreenCaptureKit` delivers frames via callbacks, so we bridge to
    /// a blocking `recv_timeout`).
    ///
    /// On Windows this calls into DXGI `AcquireNextFrame` directly and
    /// must **not** be used after [`start()`](Self::start).
    ///
    /// Returns `Ok(None)` when no new desktop content is available
    /// within the frame-period timeout.
    pub fn poll_frame(&self) -> Result<Option<Frame>, CaptureError> {
        self.inner.poll_frame()
    }

    /// Block until the next frame is available or the timeout elapses.
    ///
    /// Returns `Ok(None)` on timeout, or `Err` if the stream ended.
    pub fn next_frame_timeout(
        &self,
        timeout: std::time::Duration,
    ) -> Result<Option<Frame>, CaptureError> {
        self.inner.next_frame_timeout(timeout)
    }

    /// Block until the next audio frame is available.
    ///
    /// Returns `CaptureError::Unsupported` if audio capture is not enabled.
    pub fn next_audio_frame(&self) -> Result<AudioFrame, CaptureError> {
        self.inner.next_audio_frame()
    }

    /// Try to get the next audio frame without blocking.
    ///
    /// Returns `CaptureError::Unsupported` if audio capture is not enabled.
    pub fn try_next_audio_frame(&self) -> Result<Option<AudioFrame>, CaptureError> {
        self.inner.try_next_audio_frame()
    }

    /// Returns true if this stream was created with audio capture enabled.
    #[must_use]
    pub fn has_audio(&self) -> bool {
        self.inner.has_audio()
    }
}

/// List available displays.
pub fn displays() -> Result<Vec<Display>, CaptureError> {
    backend::platform_displays()
}

/// Create a capture stream for the given display and configuration.
pub fn create_capture_stream(
    display: &Display,
    config: &CaptureConfig,
) -> Result<CaptureStream, CaptureError> {
    config.validate(display)?;
    let inner = backend::PlatformStream::new(display, config)?;
    Ok(CaptureStream { inner })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_capture_config_default() {
        let config = CaptureConfig::default();
        assert!(config.width.is_none());
        assert!(config.height.is_none());
        assert!((config.fps - 60.0).abs() < f64::EPSILON);
        assert_eq!(config.pixel_format, PixelFormat::Bgra8);
        assert!(config.show_cursor);
        assert!(!config.capture_audio);
        assert_eq!(config.audio_sample_rate, 48_000);
        assert_eq!(config.audio_channels, 2);
    }

    #[cfg(target_os = "macos")]
    fn require_display() -> Option<Display> {
        match displays() {
            Ok(ref d) if d.is_empty() => {
                eprintln!("SKIP: no displays available (headless environment?)");
                None
            }
            Ok(d) => d.into_iter().next(),
            Err(e) => {
                eprintln!("SKIP: cannot query displays: {e}");
                None
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a logged-in graphical session and screen recording permission"]
    fn test_list_displays() {
        let Some(display) = require_display() else {
            return;
        };
        assert!(display.width > 0, "display width should be positive");
        assert!(display.height > 0, "display height should be positive");
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a logged-in graphical session and screen recording permission"]
    fn test_create_capture_stream() {
        let Some(display) = require_display() else {
            return;
        };
        let config = CaptureConfig::default();
        match create_capture_stream(&display, &config) {
            Ok(_stream) => {} // success — stream created in stopped state
            Err(e) => {
                eprintln!("SKIP: cannot create capture stream: {e}");
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a logged-in graphical session and screen recording permission"]
    fn test_capture_one_frame() {
        use std::time::{Duration, Instant};

        let Some(display) = require_display() else {
            return;
        };

        let config = CaptureConfig {
            fps: 30.0,
            ..CaptureConfig::default()
        };

        let stream = match create_capture_stream(&display, &config) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("SKIP: cannot create capture stream: {e}");
                return;
            }
        };

        if let Err(e) = stream.start() {
            eprintln!("SKIP: cannot start capture: {e}");
            return;
        }

        // Poll for a frame with a timeout.
        let deadline = Instant::now() + Duration::from_secs(5);
        let frame = loop {
            if Instant::now() > deadline {
                stream.stop().ok();
                panic!("timed out waiting for a captured frame (5 s)");
            }
            match stream.try_next_frame() {
                Ok(Some(f)) => break f,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(e) => {
                    stream.stop().ok();
                    panic!("error while receiving frame: {e}");
                }
            }
        };

        assert!(frame.width > 0, "frame width should be positive");
        assert!(frame.height > 0, "frame height should be positive");
        assert!(
            frame.stride >= frame.width * 4,
            "stride should cover at least width×4 (BGRA)"
        );
        assert_eq!(frame.pixel_format, PixelFormat::Bgra8);

        let surface = frame.surface();
        assert!(
            !surface.as_raw_ptr().is_null(),
            "IOSurface raw pointer should be non-null"
        );
        assert!(
            surface.io_surface_id() > 0,
            "IOSurfaceID should be positive"
        );

        let pixels = frame.copy_pixels().expect("copy_pixels should succeed");
        let expected_len = frame.height as usize * frame.stride as usize;
        assert_eq!(
            pixels.len(),
            expected_len,
            "pixel data length should be height × stride"
        );

        stream.stop().expect("stop should succeed");
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a logged-in graphical session and screen recording permission"]
    fn test_stop_then_stream_ends() {
        use std::time::{Duration, Instant};

        let Some(display) = require_display() else {
            return;
        };

        let stream = match create_capture_stream(&display, &CaptureConfig::default()) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("SKIP: cannot create capture stream: {e}");
                return;
            }
        };

        if let Err(e) = stream.start() {
            eprintln!("SKIP: cannot start capture: {e}");
            return;
        }

        // Give the stream a moment to produce at least one frame.
        std::thread::sleep(Duration::from_millis(200));

        stream.stop().expect("stop should succeed");

        // After stopping, try_next_frame should eventually return StreamEnded
        // (once the channel drains). Drain any buffered frames first.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if Instant::now() > deadline {
                // Channel may still have buffered frames — that's fine.
                break;
            }
            match stream.try_next_frame() {
                Ok(Some(_)) => {} // drain buffered frames
                Ok(None) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(CaptureError::StreamEnded) => break, // expected
                Err(e) => panic!("unexpected error after stop: {e}"),
            }
        }
    }
}
