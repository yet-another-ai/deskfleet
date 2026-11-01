//! Capture and encoding shared by the user process and the Windows desktop helper.

use std::time::{Duration, Instant};

use deskfleet_capture::{CaptureConfig, CaptureStream, Frame};
use deskfleet_encoder::{
    Codec, EncodedPacket, Encoder, EncoderConfig, H264Profile, OpusEncoder, OpusEncoderConfig,
};

use super::{DesktopConfig, MediaError, Packet};

pub(crate) struct CaptureBatch {
    pub packets: Vec<Packet>,
    pub encoder_started: bool,
}

/// All GPU state stays on its creating thread. Only encoded packets leave it.
pub(crate) struct CapturePipeline {
    encoder: Option<Encoder>,
    retained: RetainedVideoFrame<Frame>,
    capture: Option<CaptureStream>,
    opus: Option<OpusEncoder>,
    config: DesktopConfig,
    codec: Codec,
    fps: f64,
    dimensions: (u32, u32),
    generation: u64,
}

impl CapturePipeline {
    pub(crate) fn new(
        config: DesktopConfig,
        codec: Codec,
        audio: bool,
    ) -> Result<Self, MediaError> {
        config.validate()?;
        let display = deskfleet_capture::displays()?
            .into_iter()
            .find(|display| display.id == config.display_id)
            .ok_or(MediaError::DisplayNotFound(config.display_id))?;
        let fps = if display.refresh_rate_hz > 0.0 {
            config.fps.min(display.refresh_rate_hz)
        } else {
            config.fps
        };
        let capture = deskfleet_capture::create_capture_stream(
            &display,
            &CaptureConfig {
                fps,
                capture_audio: audio,
                ..CaptureConfig::default()
            },
        )?;
        let generation = capture.desktop_generation();
        Ok(Self {
            encoder: None,
            retained: RetainedVideoFrame::new(),
            capture: Some(capture),
            opus: audio
                .then(|| OpusEncoder::new(&OpusEncoderConfig::default()))
                .transpose()?,
            config,
            codec,
            fps,
            dimensions: (0, 0),
            generation,
        })
    }

    pub(crate) fn poll(&mut self, keyframe: bool) -> Result<CaptureBatch, MediaError> {
        let capture = self.capture.as_ref().ok_or(MediaError::Startup)?;
        let captured = capture.poll_frame()?;
        let generation = capture.desktop_generation();
        if generation != self.generation {
            // Never answer a PLI with pixels from the desktop we just left.
            // Recreate the encoder even when the next desktop has the same size.
            self.encoder = None;
            self.retained.clear();
            self.dimensions = (0, 0);
            self.generation = generation;
        }
        if let Some(frame) = captured.as_ref()
            && self.dimensions != (frame.width, frame.height)
        {
            self.encoder = Some(
                Encoder::new(&EncoderConfig {
                    width: frame.width,
                    height: frame.height,
                    fps: self.fps,
                    codec: self.codec,
                    bitrate_bps: self.config.bitrate_bps,
                    max_bitrate_bps: self.config.max_bitrate_bps,
                    h264_profile: H264Profile::ConstrainedBaseline,
                    ..EncoderConfig::default()
                })
                .map_err(MediaError::VideoEncoder)?,
            );
            self.dimensions = (frame.width, frame.height);
        }
        let mut packets = Vec::new();
        let captured = captured.map(|frame| {
            let timestamp = frame.timestamp_ns;
            (frame, timestamp)
        });
        if let Some(encoded) = self.retained.submit(
            captured,
            keyframe,
            Instant::now(),
            |frame, timestamp, keyframe| {
                frame.timestamp_ns = timestamp;
                let encoder = self.encoder.as_mut().ok_or(MediaError::Startup)?;
                if keyframe {
                    encoder.request_keyframe();
                }
                encoder.encode(frame).map_err(MediaError::VideoEncoder)
            },
        ) {
            append_video(&mut packets, encoded?, self.fps);
        }
        if let Some(encoder) = self.encoder.as_mut() {
            append_video(
                &mut packets,
                encoder.poll_output().map_err(MediaError::VideoEncoder)?,
                self.fps,
            );
        }
        if let Some(opus) = self.opus.as_mut() {
            while let Some(frame) = capture.try_next_audio_frame()? {
                for packet in opus.encode(&frame.samples)? {
                    packets.push(Packet::Audio(
                        packet.data,
                        Duration::from_nanos(packet.duration_ns),
                    ));
                }
            }
        }
        Ok(CaptureBatch {
            packets,
            encoder_started: self.encoder.is_some(),
        })
    }

    pub(crate) fn stop(mut self) -> Result<(), MediaError> {
        self.close()
    }

    fn close(&mut self) -> Result<(), MediaError> {
        // Encoder registrations and retained surfaces must go before capture.
        self.encoder = None;
        self.retained.clear();
        if let Some(capture) = self.capture.take() {
            capture.stop()?;
        }
        Ok(())
    }
}

impl Drop for CapturePipeline {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            tracing::warn!(%error, "desktop capture cleanup failed");
        }
    }
}

fn append_video(packets: &mut Vec<Packet>, encoded: Vec<EncodedPacket>, fps: f64) {
    for packet in encoded {
        if packet.data.is_empty() {
            continue;
        }
        let duration = if packet.duration_ns == 0 {
            Duration::from_secs_f64(1.0 / fps)
        } else {
            Duration::from_nanos(packet.duration_ns)
        };
        packets.push(Packet::Video(packet.data, duration));
    }
}

/// Holds exactly one capture-owned surface until a newer frame replaces it.
/// The generic frame lets scheduling and ownership be exercised without a GPU.
struct RetainedVideoFrame<T> {
    latest: Option<(T, u64, Instant)>,
    last_timestamp: Option<u64>,
    keyframe_requested: bool,
}

impl<T> RetainedVideoFrame<T> {
    fn clear(&mut self) {
        self.latest = None;
        self.keyframe_requested = true;
        // Keep timestamps monotonic across a desktop/encoder replacement.
    }

    fn new() -> Self {
        Self {
            latest: None,
            last_timestamp: None,
            keyframe_requested: false,
        }
    }

    fn submit<R>(
        &mut self,
        captured: Option<(T, u64)>,
        keyframe_requested: bool,
        now: Instant,
        encode: impl FnOnce(&mut T, u64, bool) -> R,
    ) -> Option<R> {
        let fresh = captured.is_some();
        if let Some((frame, timestamp)) = captured {
            self.latest = Some((frame, timestamp, now));
        }
        self.keyframe_requested |= keyframe_requested;
        if !fresh && !self.keyframe_requested {
            return None;
        }
        let (frame, captured_timestamp, captured_at) = self.latest.as_mut()?;
        let elapsed =
            u64::try_from(now.duration_since(*captured_at).as_nanos()).unwrap_or(u64::MAX);
        let mut timestamp = captured_timestamp.saturating_add(elapsed);
        if let Some(previous) = self.last_timestamp {
            // MF uses 100 ns ticks; preserve ordering after its time conversion.
            timestamp = timestamp.max(previous.saturating_add(100));
        }
        self.last_timestamp = Some(timestamp);
        let keyframe = std::mem::take(&mut self.keyframe_requested);
        Some(encode(frame, timestamp, keyframe))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_change_discards_old_pixels_even_when_a_keyframe_is_requested() {
        let now = Instant::now();
        let mut retained = RetainedVideoFrame::new();
        assert_eq!(
            retained.submit(Some((7, 1_000)), false, now, |frame, _, _| *frame),
            Some(7)
        );
        retained.clear();
        assert!(
            retained
                .submit(None, true, now, |_: &mut u8, _, _| panic!(
                    "old desktop must not be encoded"
                ))
                .is_none()
        );
        assert_eq!(
            retained.submit(Some((8, 0)), false, now, |frame, timestamp, keyframe| (
                *frame, timestamp, keyframe
            )),
            Some((8, 1_100, true))
        );
    }
    #[test]
    fn keyframe_feedback_resubmits_unchanged_frame_without_repeating_idle_polls() {
        let start = Instant::now();
        let mut retained = RetainedVideoFrame::new();
        let mut submitted = Vec::new();
        let mut encode = |frame: &mut u8, timestamp, keyframe| {
            submitted.push((*frame, timestamp, keyframe));
        };

        retained.submit(Some((7, 1_000)), false, start, &mut encode);
        assert!(
            retained
                .submit(None, false, start + Duration::from_millis(10), &mut encode)
                .is_none()
        );
        retained.submit(None, true, start + Duration::from_millis(20), &mut encode);
        assert!(
            retained
                .submit(None, false, start + Duration::from_millis(30), &mut encode)
                .is_none()
        );
        retained.submit(None, true, start + Duration::from_millis(40), &mut encode);
        // A newly queued capture may predate the most recent repeated frame.
        retained.submit(
            Some((8, 30_001_000)),
            false,
            start + Duration::from_millis(50),
            &mut encode,
        );
        assert_eq!(
            submitted,
            [
                (7, 1_000, false),
                (7, 20_001_000, true),
                (7, 40_001_000, true),
                (8, 40_001_100, false),
            ]
        );
        assert!(
            submitted
                .windows(2)
                .all(|pair| pair[0].1 / 100 < pair[1].1 / 100)
        );
    }

    #[test]
    fn retains_surface_until_replaced_and_coalesces_feedback_before_first_frame() {
        use std::cell::Cell;
        use std::rc::Rc;

        struct Surface(Rc<Cell<usize>>);
        impl Drop for Surface {
            fn drop(&mut self) {
                self.0.set(self.0.get() + 1);
            }
        }

        let dropped = Rc::new(Cell::new(0));
        let mut retained = RetainedVideoFrame::new();
        let now = Instant::now();
        assert!(
            retained
                .submit(None, true, now, |_: &mut Surface, _, _| panic!(
                    "no capture yet"
                ))
                .is_none()
        );
        assert!(
            retained
                .submit(None, true, now, |_: &mut Surface, _, _| panic!(
                    "no capture yet"
                ))
                .is_none()
        );
        let keyframe = retained.submit(
            Some((Surface(Rc::clone(&dropped)), 0)),
            false,
            now,
            |_, _, keyframe| keyframe,
        );
        assert_eq!(keyframe, Some(true));
        assert_eq!(dropped.get(), 0);
        retained.submit(None, true, now + Duration::from_millis(10), |_, _, _| {});
        assert_eq!(
            dropped.get(),
            0,
            "a repeated frame must retain the same surface"
        );
        retained.submit(
            Some((Surface(Rc::clone(&dropped)), 20_000_000)),
            false,
            now + Duration::from_millis(20),
            |_, _, _| {},
        );
        assert_eq!(
            dropped.get(),
            1,
            "only the replaced surface returns to capture"
        );
        drop(retained);
        assert_eq!(dropped.get(), 2);
    }
}
