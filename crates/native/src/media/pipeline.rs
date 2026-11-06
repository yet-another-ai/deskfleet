//! Capture and encoding shared by the user process and the Windows desktop helper.

use std::time::{Duration, Instant};

use deskfleet_capture::{CaptureConfig, CaptureStream, Frame, FrameScaler};
use deskfleet_encoder::{
    Codec, EncodedPacket, Encoder, EncoderConfig, EncoderError, H264Profile, OpusEncoder,
    OpusEncoderConfig,
};

use crate::rtc::BitrateController;

use super::{DesktopConfig, MediaError, Packet};

pub(crate) struct CaptureBatch {
    pub packets: Vec<Packet>,
    pub encoder_started: bool,
}

/// All GPU state stays on its creating thread. Only encoded packets leave it.
pub(crate) struct CapturePipeline {
    encoder: Option<Encoder>,
    retained: RetainedVideoFrame<Frame>,
    scaler: FrameScaler,
    capture: Option<CaptureStream>,
    opus: Option<OpusEncoder>,
    config: DesktopConfig,
    codec: Codec,
    fps: f64,
    dimensions: (u32, u32),
    generation: u64,
    cadence: VideoCadence,
    bitrate: BitrateController,
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
                // ScreenCaptureKit can resize before publishing its surfaces.
                #[cfg(target_os = "macos")]
                width: config
                    .max_width
                    .map(|_| config.output_dimensions(display.width, display.height).0),
                #[cfg(target_os = "macos")]
                height: config
                    .max_height
                    .map(|_| config.output_dimensions(display.width, display.height).1),
                ..CaptureConfig::default()
            },
        )?;
        let generation = capture.desktop_generation();
        let bitrate = BitrateController::new(config.bitrate_ceiling());
        Ok(Self {
            encoder: None,
            retained: RetainedVideoFrame::new(),
            scaler: FrameScaler::default(),
            capture: Some(capture),
            opus: audio
                .then(|| OpusEncoder::new(&OpusEncoderConfig::default()))
                .transpose()?,
            config,
            codec,
            fps,
            dimensions: (0, 0),
            generation,
            cadence: VideoCadence::new(fps),
            bitrate,
        })
    }

    /// Apply a GCC/TWCC bandwidth estimate (bits/sec) to the live encoder.
    ///
    /// Platforms that cannot retarget bitrate live (for example Windows NVENC)
    /// recreate once at the configured ceiling and then leave the rate fixed.
    pub(crate) fn apply_bandwidth_estimate(
        &mut self,
        estimate_bps: f64,
    ) -> Result<(), MediaError> {
        let Some(target) = self.bitrate.observe_estimate(estimate_bps) else {
            return Ok(());
        };
        self.apply_encoder_bitrate(target)
    }

    fn apply_encoder_bitrate(&mut self, target: u32) -> Result<(), MediaError> {
        let ceiling = self.bitrate.ceiling_bps();
        let Some(encoder) = self.encoder.as_ref() else {
            return Ok(());
        };
        match encoder.set_bitrate(target, ceiling) {
            Ok(()) => Ok(()),
            Err(EncoderError::Unsupported(reason)) => {
                tracing::warn!(
                    reason,
                    ceiling_bps = ceiling,
                    "live encoder bitrate changes unsupported; freezing at configured ceiling"
                );
                if self.bitrate.disable_live_adaptation() {
                    self.encoder = None;
                    self.dimensions = (0, 0);
                    self.retained.clear();
                    self.bitrate.freeze_at_ceiling();
                }
                Ok(())
            }
            Err(error) => Err(MediaError::VideoEncoder(error)),
        }
    }

    pub(crate) fn poll(&mut self, keyframe: bool) -> Result<CaptureBatch, MediaError> {
        let capture = self.capture.as_ref().ok_or(MediaError::Startup)?;
        let now = Instant::now();
        let (capture_due, keyframe) = self.cadence.poll(now, keyframe);
        let captured = if capture_due {
            capture.poll_frame()?
        } else {
            // Keep draining asynchronous encoder/audio output without busy-polling
            // or acquiring full-size desktop surfaces between preview frames.
            std::thread::sleep(self.cadence.wait(now).min(Duration::from_millis(5)));
            None
        };
        let generation = capture.desktop_generation();
        if generation != self.generation {
            // Never answer a PLI with pixels from the desktop we just left.
            // Recreate the encoder even when the next desktop has the same size.
            self.encoder = None;
            self.retained.clear();
            self.dimensions = (0, 0);
            self.generation = generation;
        }
        let captured = captured
            .map(|frame| {
                let (width, height) = self.config.output_dimensions(frame.width, frame.height);
                self.scaler.resize(frame, width, height)
            })
            .transpose()?;
        if let Some(frame) = captured.as_ref()
            && self.dimensions != (frame.width, frame.height)
        {
            self.encoder = Some(
                Encoder::new(&EncoderConfig {
                    width: frame.width,
                    height: frame.height,
                    fps: self.fps,
                    codec: self.codec,
                    bitrate_bps: self.bitrate.encoder_open_bitrate_bps(),
                    max_bitrate_bps: self.bitrate.ceiling_bps(),
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
        self.scaler = FrameScaler::default();
        if let Some(capture) = self.capture.take() {
            capture.stop()?;
        }
        Ok(())
    }
}

/// DXGI's acquisition timeout does not limit the rate of changing desktops.
/// Bound acquisition itself and retain PLI requests until the next video tick.
struct VideoCadence {
    period: Duration,
    next: Option<Instant>,
    keyframe: bool,
}

impl VideoCadence {
    fn new(fps: f64) -> Self {
        Self {
            period: Duration::from_secs_f64(1.0 / fps),
            next: None,
            keyframe: false,
        }
    }

    fn wait(&self, now: Instant) -> Duration {
        self.next
            .map_or(Duration::ZERO, |next| next.saturating_duration_since(now))
    }

    fn poll(&mut self, now: Instant, keyframe: bool) -> (bool, bool) {
        self.keyframe |= keyframe;
        if self.wait(now) != Duration::ZERO {
            return (false, false);
        }
        self.next = Some(now + self.period);
        (true, std::mem::take(&mut self.keyframe))
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
    #[ignore = "requires an interactive desktop and hardware H.264 encoder"]
    fn preview_capture_encodes_bounded_frames() {
        let display = deskfleet_capture::displays()
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        let mut pipeline = CapturePipeline::new(
            DesktopConfig {
                display_id: display.id,
                fps: 1.0,
                bitrate_bps: 150_000,
                max_bitrate_bps: 0,
                max_width: Some(320),
                max_height: Some(180),
            },
            Codec::H264,
            false,
        )
        .unwrap();
        let started = Instant::now();
        let mut frames = 0;
        while started.elapsed() < Duration::from_secs(3) {
            // Repeated feedback also exercises an idle desktop without relying on
            // user activity. No captured image or encoded packet is saved.
            let batch = pipeline.poll(true).unwrap();
            frames += batch
                .packets
                .iter()
                .filter(|packet| matches!(packet, Packet::Video(..)))
                .count();
        }
        assert!(frames > 0, "the local preview encoder must produce video");
        assert!(
            frames <= 4,
            "preview emitted {frames} frames in three seconds"
        );
        assert!(pipeline.dimensions.0 > 0 && pipeline.dimensions.0 <= 320);
        assert!(pipeline.dimensions.1 > 0 && pipeline.dimensions.1 <= 180);
        eprintln!(
            "local preview: {}x{}, {frames} H.264 frames in {:?}",
            pipeline.dimensions.0,
            pipeline.dimensions.1,
            started.elapsed()
        );
        pipeline.stop().unwrap();
    }
    #[test]
    fn preview_cadence_limits_capture_and_coalesces_keyframe_requests() {
        let now = Instant::now();
        let mut cadence = VideoCadence::new(1.0);
        assert_eq!(cadence.poll(now, false), (true, false));
        for millis in [1, 200, 500, 999] {
            assert_eq!(
                cadence.poll(now + Duration::from_millis(millis), true),
                (false, false)
            );
        }
        assert_eq!(
            cadence.poll(now + Duration::from_secs(1), false),
            (true, true)
        );
        assert_eq!(
            cadence.poll(now + Duration::from_secs(2), false),
            (true, false)
        );
    }
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
