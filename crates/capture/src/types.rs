use crate::PixelFormat;

/// A capturable display.
#[derive(Debug, Clone)]
pub struct Display {
    /// Platform-specific display identifier.
    pub id: u32,
    /// Human-readable platform name, separate from the capture identifier.
    pub name: Option<String>,
    /// User-facing number when the platform can preserve a monitor association.
    pub display_number: Option<u32>,
    /// Display width in pixels.
    pub width: u32,
    /// Display height in pixels.
    pub height: u32,
    /// Display refresh rate in Hz (0.0 if unknown).
    pub refresh_rate_hz: f64,
}

/// Configuration for a capture stream.
#[derive(Debug, Clone)]
pub struct CaptureConfig {
    /// Desired output width in pixels. Uses display width if `None`.
    pub width: Option<u32>,
    /// Desired output height in pixels. Uses display height if `None`.
    pub height: Option<u32>,
    /// Target frame rate.
    pub fps: f64,
    /// Desired pixel format.
    pub pixel_format: PixelFormat,
    /// Whether to include the cursor in captured frames.
    pub show_cursor: bool,
    /// Whether to capture system audio.
    pub capture_audio: bool,
    /// Audio sample rate in Hz (used when `capture_audio` is true).
    pub audio_sample_rate: u32,
    /// Number of audio channels (used when `capture_audio` is true).
    pub audio_channels: u16,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            width: None,
            height: None,
            fps: 60.0,
            pixel_format: PixelFormat::Bgra8,
            show_cursor: true,
            capture_audio: false,
            audio_sample_rate: 48_000,
            audio_channels: 2,
        }
    }
}

impl CaptureConfig {
    pub(crate) fn validate(&self, display: &Display) -> Result<(), crate::CaptureError> {
        if !self.fps.is_finite() || self.fps < 1.0 || self.fps > 1000.0 {
            return Err(crate::CaptureError::InvalidConfig(
                "fps must be finite and in [1, 1000]",
            ));
        }
        if self.width.unwrap_or(display.width) == 0 || self.height.unwrap_or(display.height) == 0 {
            return Err(crate::CaptureError::InvalidConfig(
                "dimensions must be positive",
            ));
        }
        if self.capture_audio
            && (!matches!(self.audio_sample_rate, 8000 | 12000 | 16000 | 24000 | 48000)
                || !matches!(self.audio_channels, 1 | 2))
        {
            return Err(crate::CaptureError::InvalidConfig(
                "unsupported audio sample rate or channel count",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_config_without_initializing_capture() {
        let display = Display {
            id: 1,
            name: None,
            display_number: None,
            width: 1920,
            height: 1080,
            refresh_rate_hz: 60.0,
        };
        for fps in [0.0, -1.0, f64::MIN_POSITIVE, f64::NAN, f64::INFINITY] {
            let config = CaptureConfig {
                fps,
                ..CaptureConfig::default()
            };
            assert!(matches!(
                crate::create_capture_stream(&display, &config),
                Err(crate::CaptureError::InvalidConfig(_))
            ));
        }
        let config = CaptureConfig {
            width: Some(0),
            ..CaptureConfig::default()
        };
        assert!(config.validate(&display).is_err());
        let config = CaptureConfig {
            capture_audio: true,
            audio_channels: 3,
            ..CaptureConfig::default()
        };
        assert!(config.validate(&display).is_err());
    }
}
