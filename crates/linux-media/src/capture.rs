use std::cell::Cell;
use std::os::fd::{AsRawFd, OwnedFd};
use std::time::{Duration, Instant};

use crate::pipeline::Pipeline;
use crate::{Error, Result};

/// Tightly packed BGRA pixels, independent of the PipeWire buffer pool.
#[derive(Debug)]
pub struct VideoFrame {
    pub width: u32,
    pub height: u32,
    pub timestamp_ns: u64,
    pub pixels: Vec<u8>,
}

/// A connection to one stream in an already authorized portal session.
pub struct Capture {
    // Stop/join the pipeline before closing the fd it uses.
    pipeline: Pipeline,
    _remote: OwnedFd,
    start: Instant,
    last_frame: Cell<Option<Instant>>,
    frame_period: Duration,
}

impl Capture {
    pub fn new(remote: OwnedFd, node_id: u32, serial: Option<u64>, fps: f64) -> Result<Self> {
        if !fps.is_finite() || !(1.0..=1000.0).contains(&fps) {
            return Err(Error::Pipeline("invalid capture frame rate".into()));
        }
        let target = match serial {
            Some(serial) => format!("target-object={serial}"),
            None => format!("path={node_id}"),
        };
        // No DMA-BUF caps: this first implementation negotiates system memory
        // deliberately, then copies before returning the sample to PipeWire.
        let pipeline = Pipeline::new(&format!(
            "pipewiresrc fd={} {target} do-timestamp=true ! videoconvert ! \
             video/x-raw,format=BGRA ! appsink name=frames sync=false \
             max-buffers=1 drop=true enable-last-sample=false wait-on-eos=false",
            remote.as_raw_fd()
        ))?;
        Ok(Self {
            pipeline,
            _remote: remote,
            start: Instant::now(),
            last_frame: Cell::new(None),
            frame_period: Duration::from_secs_f64(1.0 / fps),
        })
    }

    pub fn next_frame(&self, timeout: Duration) -> Result<Option<VideoFrame>> {
        let Some(sample) = self.pipeline.pull(timeout)? else {
            return Ok(None);
        };
        let now = Instant::now();
        if self
            .last_frame
            .get()
            .is_some_and(|last| now.duration_since(last) < self.frame_period)
        {
            return Ok(None);
        }
        let (width, height) = sample.dimensions()?;
        let (offset, stride) = sample.layout(width, height)?;
        let bytes = sample.bytes()?;
        let pixels = packed_bgra(&bytes, width, height, offset, stride)?;
        self.last_frame.set(Some(now));
        Ok(Some(VideoFrame {
            width,
            height,
            timestamp_ns: u64::try_from(self.start.elapsed().as_nanos()).unwrap_or(u64::MAX),
            pixels,
        }))
    }

    pub fn stop(&self) -> Result<()> {
        self.pipeline.stop()
    }
}

fn packed_bgra(
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

    #[test]
    #[ignore = "requires the optional GStreamer runtime and videotestsrc plugin"]
    fn runtime_copies_real_video_sample() {
        let pipeline = Pipeline::new("videotestsrc num-buffers=1 ! video/x-raw,format=BGRA,width=16,height=8 ! appsink name=frames sync=false").unwrap();
        let sample = pipeline.pull(Duration::from_secs(2)).unwrap().unwrap();
        assert_eq!(sample.dimensions().unwrap(), (16, 8));
        let (offset, stride) = sample.layout(16, 8).unwrap();
        assert_eq!(
            packed_bgra(&sample.bytes().unwrap(), 16, 8, offset, stride)
                .unwrap()
                .len(),
            16 * 8 * 4
        );
    }
}
