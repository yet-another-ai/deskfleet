//! H.264 sample ownership and stride-aware CoreVideo readback.

use std::{
    ffi::c_void,
    ptr::{self, NonNull},
    time::Instant,
};

use objc2_core_foundation::CFRetained;
use objc2_core_media::{
    CMBlockBuffer, CMFormatDescription, CMSampleBuffer, CMSampleTimingInfo, CMTime, CMTimeFlags,
    CMVideoFormatDescriptionCreateFromH264ParameterSets,
};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetHeight, CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
    kCVPixelFormatType_32BGRA,
};

use crate::{Error, Frame};

pub(super) const INVALID_TIME: CMTime = CMTime {
    value: 0,
    timescale: 0,
    flags: CMTimeFlags::empty(),
    epoch: 0,
};

pub(super) fn check(status: i32, operation: &str) -> Result<(), Error> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{operation} failed with OSStatus {status}").into())
    }
}

#[derive(Default)]
pub(super) struct Parameters {
    sps: Vec<u8>,
    pps: Vec<u8>,
}

pub(super) struct Picture {
    pub avcc: Vec<u8>,
    pub changed: bool,
    pub has_slice: bool,
    pub idr: bool,
}

impl Parameters {
    pub fn picture(&mut self, bytes: &[u8]) -> Result<Picture, Error> {
        let mut picture = Picture {
            avcc: Vec::with_capacity(bytes.len()),
            changed: false,
            has_slice: false,
            idr: false,
        };
        for nal in nals(bytes)? {
            let kind = nal[0] & 31;
            match kind {
                7 | 8 => {
                    let stored = if kind == 7 {
                        &mut self.sps
                    } else {
                        &mut self.pps
                    };
                    if stored != nal {
                        *stored = nal.to_vec();
                        picture.changed = true;
                    }
                }
                _ => {
                    picture.has_slice |= kind == 1 || kind == 5;
                    picture.idr |= kind == 5;
                    picture.avcc.extend(u32::try_from(nal.len())?.to_be_bytes());
                    picture.avcc.extend_from_slice(nal);
                }
            }
        }
        Ok(picture)
    }

    pub fn format(&self) -> Result<CFRetained<CMFormatDescription>, Error> {
        if self.sps.is_empty() || self.pps.is_empty() {
            return Err("H.264 format requires SPS and PPS".into());
        }
        let mut pointers = [NonNull::from(&self.sps[0]), NonNull::from(&self.pps[0])];
        let mut lengths = [self.sps.len(), self.pps.len()];
        let mut format = ptr::null();
        // SAFETY: Both parameter buffers are nonempty and stay live for this
        // synchronous call, which copies their data. All outputs are writable.
        check(
            unsafe {
                CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    None,
                    2,
                    NonNull::from(&mut pointers[0]),
                    NonNull::from(&mut lengths[0]),
                    4,
                    NonNull::from(&mut format),
                )
            },
            "CMVideoFormatDescriptionCreateFromH264ParameterSets",
        )?;
        let format = NonNull::new(format.cast_mut()).ok_or("CoreMedia returned no H.264 format")?;
        // SAFETY: Successful Create returned a non-null owned reference.
        Ok(unsafe { CFRetained::from_raw(format) })
    }
}

pub(super) fn nals(bytes: &[u8]) -> Result<Vec<&[u8]>, Error> {
    let mut starts = Vec::new();
    let mut cursor = 0;
    while cursor + 3 <= bytes.len() {
        let length = if bytes[cursor..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if bytes[cursor..].starts_with(&[0, 0, 1]) {
            3
        } else {
            cursor += 1;
            continue;
        };
        starts.push((cursor, cursor + length));
        cursor += length;
    }
    if starts.first().is_none_or(|(start, _)| *start != 0) {
        return Err("H.264 picture has no Annex B prefix".into());
    }
    let mut nals = Vec::with_capacity(starts.len());
    for (index, (_, start)) in starts.iter().enumerate() {
        let end = starts
            .get(index + 1)
            .map_or(bytes.len(), |(start, _)| *start);
        let nal = &bytes[*start..end];
        if nal.is_empty() {
            return Err("empty H.264 NAL unit".into());
        }
        nals.push(nal);
    }
    Ok(nals)
}

pub(super) fn sample(
    bytes: &[u8],
    timestamp: u32,
    format: &CMFormatDescription,
) -> Result<CFRetained<CMSampleBuffer>, Error> {
    let mut block = ptr::null_mut();
    // SAFETY: A null memory block requests CoreMedia-owned allocation. Its
    // extent matches the sample bytes; all output storage remains writable.
    check(
        unsafe {
            CMBlockBuffer::create_with_memory_block(
                None,
                ptr::null_mut(),
                bytes.len(),
                None,
                ptr::null(),
                0,
                bytes.len(),
                0,
                NonNull::from(&mut block),
            )
        },
        "CMBlockBufferCreateWithMemoryBlock",
    )?;
    let block = NonNull::new(block).ok_or("CoreMedia returned no block buffer")?;
    // SAFETY: Successful Create returned a non-null owned reference.
    let block = unsafe { CFRetained::from_raw(block) };
    let source =
        NonNull::new(bytes.as_ptr().cast_mut().cast::<c_void>()).ok_or("empty H.264 sample")?;
    // SAFETY: The source slice is valid for the checked copy size, and the
    // block owns an allocation of exactly this size. CoreMedia copies the data.
    check(
        unsafe { CMBlockBuffer::replace_data_bytes(source, &block, 0, bytes.len()) },
        "CMBlockBufferReplaceDataBytes",
    )?;
    let timing = CMSampleTimingInfo {
        duration: INVALID_TIME,
        presentationTimeStamp: CMTime {
            value: i64::from(timestamp),
            timescale: 90_000,
            flags: CMTimeFlags::Valid,
            epoch: 0,
        },
        decodeTimeStamp: INVALID_TIME,
    };
    let length = bytes.len();
    let mut sample = ptr::null_mut();
    // SAFETY: One timing and size entry describe one complete access unit;
    // the resulting sample retains its format and CoreMedia-owned block.
    check(
        unsafe {
            CMSampleBuffer::create_ready(
                None,
                Some(&block),
                Some(format),
                1,
                1,
                &raw const timing,
                1,
                &raw const length,
                NonNull::from(&mut sample),
            )
        },
        "CMSampleBufferCreateReady",
    )?;
    let sample = NonNull::new(sample).ok_or("CoreMedia returned no sample")?;
    // SAFETY: Successful Create returned a non-null owned reference.
    Ok(unsafe { CFRetained::from_raw(sample) })
}

struct Locked<'a>(&'a CVPixelBuffer);
impl Drop for Locked<'_> {
    fn drop(&mut self) {
        // SAFETY: This guard is created only after a successful read-only lock;
        // the matching unlock uses identical flags while the buffer is alive.
        unsafe { CVPixelBufferUnlockBaseAddress(self.0, CVPixelBufferLockFlags::ReadOnly) };
    }
}

pub(super) fn rgba(buffer: &CVPixelBuffer) -> Result<Frame, Error> {
    if CVPixelBufferGetPixelFormatType(buffer) != kCVPixelFormatType_32BGRA {
        return Err("VideoToolbox did not return BGRA pixels".into());
    }
    let width = CVPixelBufferGetWidth(buffer);
    let height = CVPixelBufferGetHeight(buffer);
    let stride = CVPixelBufferGetBytesPerRow(buffer);
    let row = width.checked_mul(4).ok_or("decoded row size overflow")?;
    let size = stride
        .checked_mul(height)
        .ok_or("decoded buffer size overflow")?;
    if width == 0 || height == 0 || stride < row || size > isize::MAX as usize {
        return Err("invalid decoded pixel layout".into());
    }
    // SAFETY: The live pixel buffer is read-only for the duration of this guard.
    check(
        unsafe { CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly) },
        "CVPixelBufferLockBaseAddress",
    )?;
    let _locked = Locked(buffer);
    let base = CVPixelBufferGetBaseAddress(buffer);
    if base.is_null() {
        return Err("decoded pixel buffer has no base address".into());
    }
    // SAFETY: CoreVideo's locked BGRA buffer exposes height rows at this stride;
    // the checked size is representable as a Rust slice and copied before unlock.
    let bytes = unsafe { std::slice::from_raw_parts(base.cast::<u8>(), size) };
    let mut pixels = Vec::with_capacity(row * height);
    for source in bytes.chunks_exact(stride) {
        for pixel in source[..row].as_chunks::<4>().0 {
            pixels.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
        }
    }
    Ok(Frame {
        width: width.try_into()?,
        height: height.try_into()?,
        pixels,
        ready_at: Instant::now(),
    })
}
