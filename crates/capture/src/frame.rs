use crate::CaptureError;
use crate::surface::NativeSurface;

/// Pixel format of a captured frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    /// 32-bit BGRA (8 bits per channel).
    Bgra8,
}

/// A captured frame backed by an owned platform surface or pixel buffer.
#[derive(Debug)]
pub struct Frame {
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
    /// Bytes per row (may include padding).
    pub stride: u32,
    /// Pixel format of the data.
    pub pixel_format: PixelFormat,
    /// Presentation timestamp in nanoseconds.
    pub timestamp_ns: u64,
    /// Platform-native GPU surface.
    surface: NativeSurface,
}

impl Frame {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    pub(crate) fn new(
        width: u32,
        height: u32,
        stride: u32,
        pixel_format: PixelFormat,
        timestamp_ns: u64,
        surface: NativeSurface,
    ) -> Self {
        Self {
            width,
            height,
            stride,
            pixel_format,
            timestamp_ns,
            surface,
        }
    }

    /// Returns the platform-native GPU surface.
    #[must_use]
    pub fn surface(&self) -> &NativeSurface {
        &self.surface
    }

    /// Copy pixel data from the owned surface into a new CPU buffer.
    pub fn copy_pixels(&self) -> Result<Vec<u8>, CaptureError> {
        self.surface.copy_pixels()
    }
}
