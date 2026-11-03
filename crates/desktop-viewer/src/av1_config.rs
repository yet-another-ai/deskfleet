//! Main-profile AV1 sequence configuration for platform decoder initialization.
use crate::Error;

pub(crate) struct Config {
    pub width: u32,
    pub height: u32,
    pub av1c: Vec<u8>,
}

struct Bits<'a> {
    data: &'a [u8],
    offset: usize,
}
impl Bits<'_> {
    fn read(&mut self, count: usize) -> Result<u32, Error> {
        if count > 32 || self.offset + count > self.data.len() * 8 {
            return Err("truncated AV1 sequence header".into());
        }
        let mut value = 0;
        for _ in 0..count {
            value =
                (value << 1) | u32::from((self.data[self.offset / 8] >> (7 - self.offset % 8)) & 1);
            self.offset += 1;
        }
        Ok(value)
    }
    fn flag(&mut self) -> Result<bool, Error> {
        Ok(self.read(1)? != 0)
    }
    fn uvlc(&mut self) -> Result<(), Error> {
        let mut count = 0;
        while !self.flag()? {
            count += 1;
            if count == 32 {
                return Ok(());
            }
        }
        self.read(count)?;
        Ok(())
    }
}

/// Parse the sequence OBU rather than trusting remote display dimensions or
/// synthesizing an av1C record that disagrees with the compressed stream.
pub(crate) fn sequence(bytes: &[u8]) -> Result<Option<Config>, Error> {
    let mut offset = 0;
    while offset < bytes.len() {
        let start = offset;
        let header = bytes[offset];
        offset += 1;
        if header & 0x81 != 0 || header & 2 == 0 {
            return Err("invalid sized AV1 OBU".into());
        }
        if header & 4 != 0 {
            offset += 1;
        }
        let mut length = 0usize;
        let mut complete = false;
        for shift in (0..56).step_by(7) {
            let byte = *bytes.get(offset).ok_or("truncated AV1 OBU size")?;
            offset += 1;
            length |= usize::from(byte & 127)
                .checked_shl(shift)
                .ok_or("AV1 OBU size overflow")?;
            if byte & 128 == 0 {
                complete = true;
                break;
            }
        }
        if !complete {
            return Err("invalid AV1 OBU size".into());
        }
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= bytes.len())
            .ok_or("truncated AV1 OBU")?;
        if (header >> 3) & 15 == 1 {
            return parse(&bytes[offset..end], &bytes[start..end]).map(Some);
        }
        offset = end;
    }
    Ok(None)
}

fn parse(payload: &[u8], obu: &[u8]) -> Result<Config, Error> {
    let mut b = Bits {
        data: payload,
        offset: 0,
    };
    let profile = b.read(3)?;
    if profile != 0 {
        return Err("AV1 decoder requires main profile".into());
    }
    b.flag()?; // still_picture
    let reduced = b.flag()?;
    let mut level = 0;
    let mut tier = 0;
    if reduced {
        level = b.read(5)?;
    } else {
        let timing = b.flag()?;
        let mut delays = None;
        if timing {
            b.read(32)?;
            b.read(32)?;
            if b.flag()? {
                b.uvlc()?;
            }
            if b.flag()? {
                delays = Some(b.read(5)? as usize + 1);
                b.read(32)?;
                b.read(5)?;
                b.read(5)?;
            }
        }
        let initial_delay = b.flag()?;
        let points = b.read(5)? + 1;
        for i in 0..points {
            b.read(12)?;
            let point_level = b.read(5)?;
            let point_tier = if point_level > 7 { b.read(1)? } else { 0 };
            if i == 0 {
                level = point_level;
                tier = point_tier;
            }
            if let Some(count) = delays
                && b.flag()?
            {
                b.read(count)?;
                b.read(count)?;
                b.flag()?;
            }
            if initial_delay && b.flag()? {
                b.read(4)?;
            }
        }
    }
    let width_bits = b.read(4)? as usize + 1;
    let height_bits = b.read(4)? as usize + 1;
    let width = b.read(width_bits)? + 1;
    let height = b.read(height_bits)? + 1;
    if !reduced && b.flag()? {
        b.read(4)?;
        b.read(3)?;
    }
    b.read(3)?; // superblock, filter_intra, intra_edge_filter
    if !reduced {
        b.read(4)?; // interintra, masked_compound, warped_motion, dual_filter
        let order = b.flag()?;
        if order {
            b.read(2)?;
        }
        let screen = if b.flag()? { 2 } else { b.read(1)? };
        if screen > 0 && !b.flag()? {
            b.read(1)?;
        }
        if order {
            b.read(3)?;
        }
    }
    b.read(3)?; // superres, cdef, restoration
    let high_depth = b.flag()?;
    let monochrome = b.flag()?;
    let (primaries, transfer, matrix) = if b.flag()? {
        (b.read(8)?, b.read(8)?, b.read(8)?)
    } else {
        (2, 2, 2)
    };
    if high_depth || monochrome || (primaries == 1 && transfer == 13 && matrix == 0) {
        return Err("AV1 decoder requires 8-bit main-profile 4:2:0 video".into());
    }
    b.flag()?; // color_range
    let chroma_position = b.read(2)?;
    b.flag()?; // separate_uv_delta_q
    b.flag()?; // film_grain_params_present
    let mut av1c = vec![
        0x81,
        level as u8,
        (tier as u8) << 7 | 0x0c | chroma_position as u8,
        0,
    ];
    av1c.extend_from_slice(obu);
    Ok(Config {
        width,
        height,
        av1c,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_real_main_profile_and_rejects_truncated_configuration() {
        let bytes = include_bytes!("../../native/examples/fixtures/red-64x64.av1");
        let config = sequence(bytes).unwrap().unwrap();
        assert_eq!((config.width, config.height), (64, 64));
        assert_eq!(config.av1c[0], 0x81);
        assert_eq!(config.av1c[2] & 0x7c, 0x0c);
        for length in 1..8 {
            assert!(
                sequence(&bytes[..length]).is_err()
                    || sequence(&bytes[..length]).unwrap().is_none()
            );
        }
    }
}
