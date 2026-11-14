use std::cell::Cell;
use std::os::fd::{AsRawFd, OwnedFd};
use std::time::{Duration, Instant};

use crate::pipeline::Pipeline;
use crate::pixels::packed_bgra;
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
        let started = Instant::now();
        if let Some(last) = self.last_frame.get() {
            let delay = self
                .frame_period
                .saturating_sub(started.duration_since(last));
            if !delay.is_zero() {
                self.pipeline.check_active()?;
                // Leave the newest damage in appsink's single-slot queue until
                // it is due. Pulling and discarding it here loses the final update
                // when the compositor stops producing frames after a burst.
                let wait = delay.min(timeout);
                if !wait.is_zero() {
                    std::thread::sleep(wait);
                }
                if delay > timeout {
                    self.pipeline.check_active()?;
                    return Ok(None);
                }
            }
        }
        let Some(sample) = self
            .pipeline
            .pull(timeout.saturating_sub(started.elapsed()))?
        else {
            return Ok(None);
        };
        let now = Instant::now();
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

#[cfg(test)]
#[allow(unsafe_code)]
mod tests {
    use super::*;
    use crate::pipeline::Object;

    fn capture_fixture(frame_period: Duration) -> (Capture, Object) {
        let pipeline = Pipeline::new(
            "appsrc name=input is-live=true format=time \
             caps=video/x-raw,format=BGRA,width=1,height=1,framerate=30/1 ! \
             appsink name=frames sync=false max-buffers=1 drop=true \
             enable-last-sample=false wait-on-eos=false",
        )
        .unwrap();
        let input = pipeline.child(c"input").unwrap();
        (
            Capture {
                pipeline,
                _remote: std::fs::File::open("/dev/null").unwrap().into(),
                start: Instant::now(),
                last_frame: Cell::new(None),
                frame_period,
            },
            input,
        )
    }

    fn push_pixel(input: &Object, value: u8) {
        let api = input.api;
        let pixels = [value; 4];
        // SAFETY: Allocate an owned buffer, initialize its bytes, and transfer
        // ownership to the live appsrc. No pointers outlive their backing data.
        unsafe {
            let buffer =
                (api.buffer_new_allocate)(std::ptr::null_mut(), pixels.len(), std::ptr::null_mut());
            assert!(!buffer.is_null());
            assert_eq!(
                (api.buffer_fill)(buffer, 0, pixels.as_ptr().cast(), pixels.len()),
                pixels.len()
            );
            assert_eq!((api.source_push_buffer)(input.ptr.as_ptr(), buffer), 0);
        }
    }

    fn finish_input(capture: &Capture, input: &Object) {
        let api = input.api;
        // SAFETY: input and pipeline are live objects; get_bus returns an owned
        // reference, and bus_pop_filtered transfers any returned EOS message.
        unsafe {
            assert_eq!((api.source_end_of_stream)(input.ptr.as_ptr()), 0);
            let bus = Object {
                ptr: std::ptr::NonNull::new((api.element_get_bus)(
                    capture.pipeline.element.ptr.as_ptr(),
                ))
                .unwrap(),
                api,
            };
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let message = (api.bus_pop_filtered)(bus.ptr.as_ptr(), 1); // GST_MESSAGE_EOS
                if !message.is_null() {
                    (api.mini_unref)(message.cast());
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "appsrc burst never reached appsink"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }

    #[test]
    #[ignore = "requires the optional GStreamer runtime"]
    fn runtime_pacing_retains_the_final_damage_frame() {
        let (capture, input) = capture_fixture(Duration::from_secs(1));
        push_pixel(&input, 10);
        assert_eq!(
            capture
                .next_frame(Duration::from_secs(2))
                .unwrap()
                .unwrap()
                .pixels,
            [10; 4]
        );
        push_pixel(&input, 20);
        push_pixel(&input, 30);
        // EOS is a barrier: both updates have reached the single-slot appsink,
        // and no future damage can rescue a frame accidentally consumed early.
        finish_input(&capture, &input);
        // wait-on-eos=false can mark the appsink EOS while the last buffer remains.
        // Pacing must not treat that as Ended or the final damage is dropped.
        capture
            .pipeline
            .check_active()
            .expect("EOS with a queued sample must stay active for pacing");
        capture.last_frame.set(Some(Instant::now()));
        let before = Instant::now();
        assert!(capture.next_frame(Duration::ZERO).unwrap().is_none());
        assert!(before.elapsed() < Duration::from_millis(250));
        // Advance the pacing deadline without making the test sleep for a second.
        capture
            .last_frame
            .set(Some(Instant::now() - capture.frame_period));
        let final_frame = capture
            .next_frame(Duration::ZERO)
            .unwrap()
            .expect("final damage was lost while pacing");
        assert_eq!(final_frame.pixels, [30; 4]);
        // Ended comes from an empty pull after EOS, not from pacing's
        // non-consuming active check while the frame interval is still open.
        capture
            .last_frame
            .set(Some(Instant::now() - capture.frame_period));
        assert!(matches!(
            capture.next_frame(Duration::ZERO),
            Err(Error::Ended)
        ));
    }

    #[test]
    #[ignore = "requires the optional GStreamer runtime"]
    fn runtime_pacing_obeys_timeout_and_stop() {
        let (capture, input) = capture_fixture(Duration::from_millis(200));
        push_pixel(&input, 10);
        capture.next_frame(Duration::from_secs(2)).unwrap().unwrap();
        let before = Instant::now();
        assert!(
            capture
                .next_frame(Duration::from_millis(20))
                .unwrap()
                .is_none()
        );
        assert!(before.elapsed() < Duration::from_millis(150));
        capture.last_frame.set(Some(Instant::now()));
        let before = Instant::now();
        assert!(
            capture
                .next_frame(Duration::from_millis(250))
                .unwrap()
                .is_none()
        );
        // The 200 ms pacing wait is part of the budget, not added to the pull.
        assert!(before.elapsed() < Duration::from_millis(375));
        capture.last_frame.set(Some(Instant::now()));
        capture.stop().unwrap();
        assert!(matches!(
            capture.next_frame(Duration::ZERO),
            Err(Error::Ended)
        ));
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
