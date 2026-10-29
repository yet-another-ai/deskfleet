use x11rb::protocol::xfixes::GetCursorImageReply;
use x11rb::protocol::xproto::ImageOrder;

use crate::{Error, Result};

#[derive(Clone, Copy)]
pub(crate) struct Format {
    pub bits: u8,
    pub scanline_pad: u8,
    pub order: ImageOrder,
    pub red: u32,
    pub green: u32,
    pub blue: u32,
}

/// Convert TrueColor ZPixmap pixels, including padded 16/24-bit rows, to the
/// tightly packed opaque BGRA representation shared by the Linux encoders.
pub(crate) fn bgra(bytes: &[u8], width: u32, height: u32, format: Format) -> Result<Vec<u8>> {
    if !matches!(format.bits, 16 | 24 | 32) || !matches!(format.scanline_pad, 8 | 16 | 32) {
        return Err(Error::Unavailable("unsupported X11 pixel layout".into()));
    }
    let width = width as usize;
    let height = height as usize;
    let pixel_bytes = usize::from(format.bits / 8);
    let stride = (width * usize::from(format.bits)).div_ceil(usize::from(format.scanline_pad))
        * usize::from(format.scanline_pad / 8);
    let size = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| Error::Platform("X11 frame is too large".into()))?;
    if stride
        .checked_mul(height)
        .is_none_or(|length| length > bytes.len())
    {
        return Err(Error::Platform("truncated X11 image".into()));
    }
    let mut pixels = vec![0; size];
    for y in 0..height {
        let source = &bytes[y * stride..y * stride + width * pixel_bytes];
        let target = &mut pixels[y * width * 4..(y + 1) * width * 4];
        if format.bits == 32
            && format.order == ImageOrder::LSB_FIRST
            && (format.red, format.green, format.blue) == (0x00ff_0000, 0x0000_ff00, 0x0000_00ff)
        {
            target.copy_from_slice(source);
            for pixel in target.as_chunks_mut::<4>().0 {
                pixel[3] = 255;
            }
            continue;
        }
        for (source, target) in source
            .chunks_exact(pixel_bytes)
            .zip(target.as_chunks_mut::<4>().0.iter_mut())
        {
            let value = if format.order == ImageOrder::LSB_FIRST {
                source
                    .iter()
                    .enumerate()
                    .fold(0u32, |value, (shift, byte)| {
                        value | (u32::from(*byte) << (shift * 8))
                    })
            } else {
                source
                    .iter()
                    .fold(0u32, |value, byte| (value << 8) | u32::from(*byte))
            };
            target.copy_from_slice(&[
                channel(value, format.blue),
                channel(value, format.green),
                channel(value, format.red),
                255,
            ]);
        }
    }
    Ok(pixels)
}

fn channel(value: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    (((u64::from(value & mask) >> shift) * 255) / u64::from(mask >> shift)) as u8
}

/// XFixes supplies premultiplied ARGB cursor pixels and a hotspot in root
/// coordinates. Clip against the selected monitor before compositing.
pub(crate) fn cursor(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    origin: (i16, i16),
    image: &GetCursorImageReply,
) {
    let left = i32::from(image.x) - i32::from(image.xhot) - i32::from(origin.0);
    let top = i32::from(image.y) - i32::from(image.yhot) - i32::from(origin.1);
    for y in 0..i32::from(image.height) {
        let target_y = top + y;
        if !(0..height as i32).contains(&target_y) {
            continue;
        }
        for x in 0..i32::from(image.width) {
            let target_x = left + x;
            if !(0..width as i32).contains(&target_x) {
                continue;
            }
            let Some(&argb) = image
                .cursor_image
                .get(y as usize * usize::from(image.width) + x as usize)
            else {
                continue;
            };
            let alpha = argb >> 24;
            let offset = (target_y as usize * width as usize + target_x as usize) * 4;
            for channel in 0..3 {
                let source = (argb >> (channel * 8)) & 255;
                let background = u32::from(pixels[offset + channel]);
                pixels[offset + channel] =
                    (source + (background * (255 - alpha) + 127) / 255).min(255) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_rgb565_and_padded_big_endian_rgb24() {
        let format = Format {
            bits: 16,
            scanline_pad: 32,
            order: ImageOrder::LSB_FIRST,
            red: 0xf800,
            green: 0x07e0,
            blue: 0x001f,
        };
        assert_eq!(
            bgra(&[0, 0xf8, 99, 99, 0xe0, 7, 99, 99], 1, 2, format).unwrap(),
            [0, 0, 255, 255, 0, 255, 0, 255]
        );
        let format = Format {
            bits: 24,
            order: ImageOrder::MSB_FIRST,
            red: 0xff0000,
            green: 0xff00,
            blue: 0xff,
            ..format
        };
        assert_eq!(bgra(&[1, 2, 3, 99], 1, 1, format).unwrap(), [3, 2, 1, 255]);
        assert!(bgra(&[1, 2, 3], 1, 1, format).is_err());
    }

    #[test]
    fn cursor_clips_hotspot_and_blends_premultiplied_alpha() {
        let mut pixels = vec![100, 100, 100, 255, 100, 100, 100, 255];
        let cursor_image = GetCursorImageReply {
            x: 100,
            y: 20,
            width: 2,
            height: 1,
            xhot: 1,
            yhot: 0,
            cursor_image: vec![0xffff_0000, 0x8000_8000],
            ..Default::default()
        };
        cursor(&mut pixels, 2, 1, (100, 20), &cursor_image);
        assert_eq!(pixels, [50, 178, 50, 255, 100, 100, 100, 255]);
    }
}
