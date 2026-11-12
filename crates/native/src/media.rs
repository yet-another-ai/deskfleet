//! On-demand capture → hardware encode → WebRTC, adapted from desk-fleet's streamer.
//!
//! Each shared capture source and its encoders live on one worker thread. Only
//! encoded packets cross the bounded broadcast queue; surfaces stay in Rust.

use std::sync::Arc;
use std::time::Duration;

use deskfleet_capture::{CaptureError, Display};
use deskfleet_encoder::{Codec, EncoderError};

pub(crate) mod pipeline;
use pipeline::{CaptureBatch, CapturePipeline};
mod shared;
pub use shared::{DesktopStream, DesktopStreamPool};

// Leave room for slow hardware startup within the caller's separate 45-second media-start budget.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("invalid media configuration: {0}")]
    InvalidConfig(&'static str),
    #[error("display {0} was not found")]
    DisplayNotFound(u32),
    #[error(transparent)]
    Capture(#[from] CaptureError),
    #[error(transparent)]
    Encoder(#[from] EncoderError),
    /// The negotiated video encoder failed. Audio encoder failures stay on [`Self::Encoder`].
    #[error(transparent)]
    VideoEncoder(EncoderError),
    #[error("media worker failed: {0}")]
    Worker(#[from] tokio::task::JoinError),
    #[error("cannot open Screen Recording settings: {0}")]
    PermissionSettings(#[source] std::io::Error),
    #[error("media transport failed: {0}")]
    Transport(String),
    #[error("Windows desktop service: {message}")]
    Service { message: String, encoder: bool },
    #[error("media worker stopped during startup")]
    Startup,
    /// A source failure is shared by all subscribers without losing its classification.
    #[error(transparent)]
    Shared(Arc<MediaError>),
    #[error("capture and encoding did not produce the first video packet within 30 seconds")]
    FirstFrameTimeout,
    /// The video encoder was open but never emitted a packet. Capture that never
    /// produces a frame stays [`Self::FirstFrameTimeout`].
    #[error("the video encoder produced no first packet within 30 seconds")]
    EncoderStall,
}

impl MediaError {
    /// `"encoder"` asks the viewer to open a new peer with the next common codec.
    /// Permission, display, transport, and audio failures stay unclassified.
    pub(crate) fn fallback_reason(&self) -> Option<&'static str> {
        match self {
            Self::VideoEncoder(_) | Self::EncoderStall | Self::Service { encoder: true, .. } => {
                Some("encoder")
            }
            Self::Shared(error) => error.fallback_reason(),
            _ => None,
        }
    }
}

/// Video codec support is probed only when explicitly requested.
pub async fn supported_video_codecs(display_id: u32) -> Result<Vec<String>, MediaError> {
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "linux")]
        if crate::android_scrcpy::is_configured() {
            return crate::android_scrcpy::supported_video_codecs_sync(display_id);
        }
        #[cfg(windows)]
        if let Some(mut client) = crate::windows_desktop::Client::connect()? {
            return client.codecs(display_id);
        }
        if !deskfleet_capture::displays()?
            .iter()
            .any(|display| display.id == display_id)
        {
            return Err(MediaError::DisplayNotFound(display_id));
        }
        Ok(deskfleet_encoder::supported_codecs(display_id)?
            .into_iter()
            .map(|codec| codec.as_str().to_owned())
            .collect())
    })
    .await?
}

/// Enumerating displays can require a graphical session and capture permission.
pub async fn displays() -> Result<Vec<Display>, MediaError> {
    #[cfg(target_os = "linux")]
    if !crate::android_scrcpy::is_configured()
        && deskfleet_linux_desktop::backend() == deskfleet_linux_desktop::Backend::Wayland
    {
        deskfleet_wayland::restore_access()
            .await
            .map_err(|error| CaptureError::Platform(error.to_string()))?;
    }
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "linux")]
        if crate::android_scrcpy::is_configured() {
            return Ok(crate::android_scrcpy::displays_sync()?);
        }
        #[cfg(windows)]
        if let Some(mut client) = crate::windows_desktop::Client::connect()? {
            return client.displays();
        }
        Ok(deskfleet_capture::displays()?)
    })
    .await?
}

/// Check capture permission on a worker without prompting or starting capture.
///
/// Returns `None` on platforms without an upfront permission request.
///
/// # Errors
/// Returns an error if the permission worker fails.
pub async fn check_screen_capture_access() -> Result<Option<bool>, MediaError> {
    Ok(tokio::task::spawn_blocking(deskfleet_capture::check_screen_capture_access).await?)
}

/// Request capture permission on a worker without starting capture or encoders.
/// Opens the macOS privacy pane when access remains denied.
///
/// Returns `None` on platforms without an upfront permission request.
///
/// # Errors
///
/// Returns an error if the permission worker or System Settings fails.
pub async fn request_screen_capture_access() -> Result<Option<bool>, MediaError> {
    tokio::task::spawn_blocking(|| {
        let granted = deskfleet_capture::request_screen_capture_access();
        #[cfg(target_os = "macos")]
        if granted == Some(false) {
            crate::permission_settings::open("Privacy_ScreenCapture")
                .map_err(MediaError::PermissionSettings)?;
        }
        Ok(granted)
    })
    .await?
}

#[derive(Debug, Clone)]
#[cfg_attr(any(windows, test), derive(serde::Serialize, serde::Deserialize))]
pub struct DesktopConfig {
    pub display_id: u32,
    pub fps: f64,
    /// Adaptive bitrate ceiling in bits/sec (default 8 Mbps). GCC/TWCC targets
    /// are clamped to this value before live encoder updates.
    pub bitrate_bps: u32,
    /// Optional hard peak bitrate. When non-zero it becomes the adaptive ceiling
    /// (and must be ≥ [`Self::bitrate_bps`]).
    pub max_bitrate_bps: u32,
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
}

impl DesktopConfig {
    pub(crate) fn validate(&self) -> Result<(), MediaError> {
        if !self.fps.is_finite() || !(1.0..=240.0).contains(&self.fps) {
            return Err(MediaError::InvalidConfig("fps must be between 1 and 240"));
        }
        if self.bitrate_bps == 0
            || (self.max_bitrate_bps != 0 && self.max_bitrate_bps < self.bitrate_bps)
        {
            return Err(MediaError::InvalidConfig(
                "bitrate must be positive and no greater than the nonzero maximum",
            ));
        }
        match (self.max_width, self.max_height) {
            (None, None) | (Some(2..), Some(2..)) => {}
            _ => {
                return Err(MediaError::InvalidConfig(
                    "both video bounds must be at least 2",
                ));
            }
        }
        Ok(())
    }

    /// Ceiling for congestion-driven encoder bitrate updates.
    pub(crate) fn bitrate_ceiling(&self) -> u32 {
        crate::rtc::bitrate_ceiling(self.bitrate_bps, self.max_bitrate_bps)
    }

    /// Fit within the requested box without upscaling; hardware codecs use even dimensions.
    pub(crate) fn output_dimensions(&self, width: u32, height: u32) -> (u32, u32) {
        let (Some(max_width), Some(max_height)) = (self.max_width, self.max_height) else {
            return (width, height);
        };
        let width = u64::from(width.max(2));
        let height = u64::from(height.max(2));
        let max_width = u64::from(max_width).min(width);
        let max_height = u64::from(max_height).min(height);
        let (width, height) = if max_width * height <= max_height * width {
            (max_width, height * max_width / width)
        } else {
            (width * max_height / height, max_height)
        };
        // Each result is bounded by its original u32 input.
        (((width as u32) & !1).max(2), ((height as u32) & !1).max(2))
    }
}

#[derive(Clone)]
pub(crate) enum Packet {
    /// Encoded access unit, duration, capture timestamp, and decoder entry-point flag.
    Video(bytes::Bytes, Duration, u64, bool),
    Audio(bytes::Bytes, Duration),
}

enum CaptureSource {
    Local(Box<CapturePipeline>),
    #[cfg(target_os = "linux")]
    Android(crate::android_scrcpy::ScrcpyCapture),
    #[cfg(windows)]
    Service(crate::windows_desktop::Client),
}

impl CaptureSource {
    fn open(config: DesktopConfig, codec: Codec, audio: bool) -> Result<Self, MediaError> {
        #[cfg(target_os = "linux")]
        if crate::android_scrcpy::is_configured() {
            return Ok(Self::Android(crate::android_scrcpy::ScrcpyCapture::open(
                config, codec, audio,
            )?));
        }
        #[cfg(windows)]
        if let Some(mut client) = crate::windows_desktop::Client::connect()? {
            if audio {
                return Err(MediaError::InvalidConfig(
                    "Windows system audio is unavailable",
                ));
            }
            client.start(config, codec)?;
            return Ok(Self::Service(client));
        }
        Ok(Self::Local(Box::new(CapturePipeline::new(
            config, codec, audio,
        )?)))
    }

    fn poll(
        &mut self,
        keyframe: bool,
        estimate_bps: Option<f64>,
        video_paused: bool,
    ) -> Result<CaptureBatch, MediaError> {
        match self {
            Self::Local(pipeline) => {
                if let Some(estimate) = estimate_bps {
                    pipeline.apply_bandwidth_estimate(estimate)?;
                }
                pipeline.poll(keyframe, video_paused)
            }
            #[cfg(target_os = "linux")]
            Self::Android(client) => client.poll(keyframe, video_paused),
            #[cfg(windows)]
            Self::Service(client) => {
                let target = estimate_bps.map(|estimate| estimate as u32);
                client.poll(keyframe, target, video_paused)
            }
        }
    }

    fn stop(self) -> Result<(), MediaError> {
        match self {
            Self::Local(pipeline) => (*pipeline).stop(),
            #[cfg(target_os = "linux")]
            Self::Android(client) => client.stop(),
            #[cfg(windows)]
            Self::Service(mut client) => client.stop(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_settings_fail_before_capture() {
        let mut config = DesktopConfig {
            display_id: 0,
            fps: 60.0,
            bitrate_bps: 8_000_000,
            max_bitrate_bps: 0,
            max_width: None,
            max_height: None,
        };
        for fps in [f64::NAN, f64::INFINITY, 0.0, -1.0, 241.0] {
            config.fps = fps;
            assert!(config.validate().is_err());
        }
        config.fps = 60.0;
        config.max_bitrate_bps = 1;
        assert!(config.validate().is_err());
        config.max_bitrate_bps = 0;
        assert!(config.validate().is_ok());
        config.max_width = Some(320);
        assert!(config.validate().is_err());
        config.max_height = Some(1);
        assert!(config.validate().is_err());
        config.max_height = Some(180);
        assert!(config.validate().is_ok());
    }

    #[test]
    fn preview_dimensions_fit_landscape_portrait_and_small_displays() {
        let config = DesktopConfig {
            display_id: 0,
            fps: 1.0,
            bitrate_bps: 150_000,
            max_bitrate_bps: 0,
            max_width: Some(320),
            max_height: Some(180),
        };
        assert_eq!(config.output_dimensions(3840, 2160), (320, 180));
        assert_eq!(config.output_dimensions(1920, 1200), (288, 180));
        assert_eq!(config.output_dimensions(1080, 1920), (100, 180));
        assert_eq!(config.output_dimensions(101, 77), (100, 76));
        assert_eq!(config.output_dimensions(6400, 1080), (320, 54));
        assert_eq!(config.output_dimensions(u32::MAX, u32::MAX), (180, 180));
    }

    #[test]
    fn only_video_encoder_failures_name_another_codec() {
        use deskfleet_encoder::EncoderError;

        assert_eq!(
            MediaError::VideoEncoder(EncoderError::Unsupported("nvenc")).fallback_reason(),
            Some("encoder")
        );
        assert_eq!(MediaError::EncoderStall.fallback_reason(), Some("encoder"));
        assert_eq!(
            MediaError::Encoder(EncoderError::Unsupported("opus")).fallback_reason(),
            None
        );
        for error in [
            MediaError::FirstFrameTimeout,
            MediaError::DisplayNotFound(1),
            MediaError::Transport("write failed".to_owned()),
            MediaError::Startup,
            MediaError::InvalidConfig("fps must be between 1 and 240"),
        ] {
            assert_eq!(error.fallback_reason(), None);
        }
    }
}
