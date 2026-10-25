use deskfleet_native::media;
use napi::Result;
use napi_derive::napi;

use crate::rtc::native_error;

#[napi(object)]
pub struct DisplayInfo {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    pub refresh_rate_hz: f64,
}

/// Probe the selected display's encoders on a worker thread.
#[napi]
pub async fn supported_video_codecs(display_id: u32) -> Result<Vec<String>> {
    media::supported_video_codecs(display_id)
        .await
        .map_err(native_error)
}

/// Enumerate capture displays only on explicit request.
#[napi]
pub async fn capture_displays() -> Result<Vec<DisplayInfo>> {
    Ok(media::displays()
        .await
        .map_err(native_error)?
        .into_iter()
        .map(|display| DisplayInfo {
            id: display.id,
            width: display.width,
            height: display.height,
            refresh_rate_hz: display.refresh_rate_hz,
        })
        .collect())
}

#[napi(object)]
pub struct DesktopConfig {
    pub display_id: u32,
    /// Enable mouse and keyboard input for this display after authorization.
    pub control: Option<bool>,
    pub fps: Option<f64>,
    pub bitrate_bps: Option<u32>,
    pub max_bitrate_bps: Option<u32>,
}

impl From<DesktopConfig> for media::DesktopConfig {
    fn from(config: DesktopConfig) -> Self {
        Self {
            display_id: config.display_id,
            fps: config.fps.unwrap_or(60.0),
            bitrate_bps: config.bitrate_bps.unwrap_or(8_000_000),
            max_bitrate_bps: config.max_bitrate_bps.unwrap_or(0),
        }
    }
}
