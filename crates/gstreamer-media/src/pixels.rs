use crate::{Error, Result};

/// Copy BGRA rows into tightly packed owned storage, honoring padding and offset.
pub fn packed_bgra(
    bytes: &[u8],
    width: u32,
    height: u32,
    offset: usize,
    stride: i32,
) -> Result<Vec<u8>> {
    let row = usize::try_from(width)
        .ok()
        .and_then(|w| w.checked_mul(4))
        .ok_or_else(|| Error::Pipeline("video row is too large".into()))?;
    let length = usize::try_from(height)
        .ok()
        .and_then(|h| h.checked_mul(row))
        .ok_or_else(|| Error::Pipeline("video frame is too large".into()))?;
    if row == 0 || height == 0 || u64::from(stride.unsigned_abs()) < row as u64 {
        return Err(Error::Pipeline("invalid BGRA stride".into()));
    }
    let offset =
        i64::try_from(offset).map_err(|_| Error::Pipeline("invalid video offset".into()))?;
    // Validate all rows before allocating/copying, including bottom-up frames.
    let final_row = offset
        .checked_add(i64::from(height - 1) * i64::from(stride))
        .ok_or_else(|| Error::Pipeline("invalid video offset".into()))?;
    let first = offset.min(final_row);
    let last = offset.max(final_row);
    if first < 0
        || usize::try_from(last)
            .ok()
            .and_then(|n| n.checked_add(row))
            .is_none_or(|end| end > bytes.len())
    {
        return Err(Error::Pipeline("BGRA buffer is truncated".into()));
    }
    let mut pixels = Vec::with_capacity(length);
    for y in 0..height {
        let start = (offset + i64::from(y) * i64::from(stride)) as usize;
        pixels.extend_from_slice(&bytes[start..start + row]);
    }
    Ok(pixels)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owns_pixels_and_removes_padding_and_offset() {
        let mut backing = vec![99, 99, 1, 2, 3, 4, 88, 88, 5, 6, 7, 8];
        let owned = packed_bgra(&backing, 1, 2, 2, 6).unwrap();
        backing.fill(0);
        assert_eq!(owned, [1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn handles_bottom_up_memory_and_rejects_short_rows() {
        assert_eq!(
            packed_bgra(&[1, 2, 3, 4, 5, 6, 7, 8], 1, 2, 4, -4).unwrap(),
            [5, 6, 7, 8, 1, 2, 3, 4]
        );
        assert!(packed_bgra(&[0; 7], 1, 2, 0, 4).is_err());
        assert!(packed_bgra(&[0; 8], 1, 2, 0, -4).is_err());
        assert!(packed_bgra(&[0; 8], 1, 2, 0, 3).is_err());
    }
}
