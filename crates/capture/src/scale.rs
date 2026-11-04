//! Resize captured frames before they reach the encoder.

use crate::{CaptureError, Frame};

#[cfg(target_os = "windows")]
mod windows;

/// Keeps reusable platform scaling resources on the capture worker.
#[derive(Default)]
pub struct FrameScaler {
    #[cfg(target_os = "windows")]
    windows: Option<windows::GpuScaler>,
}

impl FrameScaler {
    /// Resize a frame to the requested dimensions, preserving its timestamp.
    /// macOS capture must request its output dimensions from ScreenCaptureKit.
    pub fn resize(&mut self, frame: Frame, width: u32, height: u32) -> Result<Frame, CaptureError> {
        if width == 0 || height == 0 || width > frame.width || height > frame.height {
            return Err(CaptureError::InvalidConfig(
                "scaled dimensions must be positive and no larger than the source",
            ));
        }
        if (width, height) == (frame.width, frame.height) {
            return Ok(frame);
        }
        #[cfg(target_os = "windows")]
        {
            if self
                .windows
                .as_ref()
                .is_none_or(|scaler| !scaler.matches(&frame, width, height))
            {
                self.windows = Some(windows::GpuScaler::new(&frame, width, height)?);
            }
            self.windows
                .as_ref()
                .expect("scaler was initialized")
                .resize(&frame)
        }
        #[cfg(target_os = "linux")]
        {
            let pixels = resize_bgra(
                frame.surface().bgra_pixels(),
                frame.width,
                frame.height,
                frame.stride,
                width,
                height,
            )?;
            Ok(Frame::new(
                width,
                height,
                width * 4,
                frame.pixel_format,
                frame.timestamp_ns,
                crate::NativeSurface { inner: pixels },
            ))
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            Err(CaptureError::Unsupported(
                "resize this platform's frames in the capture configuration",
            ))
        }
    }
}

/// Box filtering keeps thin text and high-frequency desktop details visible in
/// small previews. Linux capture already owns CPU BGRA pixels, so no readback is needed.
#[cfg(any(target_os = "linux", test))]
fn resize_bgra(
    pixels: &[u8],
    source_width: u32,
    source_height: u32,
    stride: u32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, CaptureError> {
    let source_row = source_width
        .checked_mul(4)
        .ok_or(CaptureError::InvalidConfig("source row is too large"))?;
    let length = usize::try_from(u64::from(stride) * u64::from(source_height))
        .map_err(|_| CaptureError::InvalidConfig("source frame is too large"))?;
    if width == 0
        || height == 0
        || width > source_width
        || height > source_height
        || stride < source_row
        || pixels.len() < length
    {
        return Err(CaptureError::InvalidConfig("invalid BGRA resize layout"));
    }
    let output_length = usize::try_from(u64::from(width) * u64::from(height) * 4)
        .map_err(|_| CaptureError::InvalidConfig("scaled frame is too large"))?;
    let mut output = vec![0; output_length];
    for y in 0..height {
        let top = u64::from(y) * u64::from(source_height) / u64::from(height);
        let bottom = u64::from(y + 1) * u64::from(source_height) / u64::from(height);
        for x in 0..width {
            let left = u64::from(x) * u64::from(source_width) / u64::from(width);
            let right = u64::from(x + 1) * u64::from(source_width) / u64::from(width);
            let mut sums = [0_u64; 4];
            for source_y in top..bottom {
                for source_x in left..right {
                    let offset = (source_y * u64::from(stride) + source_x * 4) as usize;
                    for (sum, channel) in sums.iter_mut().zip(&pixels[offset..offset + 4]) {
                        *sum += u64::from(*channel);
                    }
                }
            }
            let count = (bottom - top) * (right - left);
            let offset = (u64::from(y) * u64::from(width) * 4 + u64::from(x) * 4) as usize;
            for (channel, sum) in output[offset..offset + 4].iter_mut().zip(sums) {
                *channel = (sum / count) as u8;
            }
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::resize_bgra;

    #[test]
    fn averages_pixels_without_including_row_padding() {
        let pixels = [
            0, 10, 20, 255, 100, 110, 120, 255, 255, 255, 255, 255, 20, 30, 40, 255, 120, 130, 140,
            255, 255, 255, 255, 255,
        ];
        assert_eq!(
            resize_bgra(&pixels, 2, 2, 12, 1, 1).unwrap(),
            [60, 70, 80, 255]
        );
    }

    #[test]
    fn retains_edges_when_source_dimensions_are_not_divisible() {
        let pixels = [0, 0, 0, 255, 90, 90, 90, 255, 150, 150, 150, 255];
        assert_eq!(
            resize_bgra(&pixels, 3, 1, 12, 2, 1).unwrap(),
            [0, 0, 0, 255, 120, 120, 120, 255]
        );
    }

    #[test]
    fn rejects_invalid_layouts() {
        for (pixels, stride, width, height) in [
            (&[0_u8; 15][..], 8, 1, 1),
            (&[0_u8; 16][..], 7, 1, 1),
            (&[0_u8; 16][..], 8, 0, 1),
            (&[0_u8; 16][..], 8, 3, 1),
        ] {
            assert!(resize_bgra(pixels, 2, 2, stride, width, height).is_err());
        }
    }
}
