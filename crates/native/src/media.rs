//! On-demand capture → hardware encode → WebRTC, adapted from desk-fleet's streamer.
//!
//! Capture and encoders live on one worker thread. Only encoded packets cross the
//! bounded queue; native surfaces never cross the Node-API boundary.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use deskfleet_capture::{CaptureConfig, CaptureError, Display};
use deskfleet_encoder::{
    Codec, EncodedPacket, Encoder, EncoderConfig, EncoderError, H264Profile, OpusEncoder,
    OpusEncoderConfig,
};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use crate::rtc::{Peer, VideoCodec};

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("invalid media configuration: {0}")]
    InvalidConfig(&'static str),
    #[error("display {0} was not found")]
    DisplayNotFound(u32),
    #[error(transparent)]
    Capture(#[from] CaptureError),
    #[error(transparent)]
    Encoder(#[from] EncoderError),
    /// The negotiated video encoder failed. Audio encoder failures stay on [`Self::Encoder`].
    #[error(transparent)]
    VideoEncoder(EncoderError),
    #[error("media worker failed: {0}")]
    Worker(#[from] tokio::task::JoinError),
    #[error("cannot open Screen Recording settings: {0}")]
    PermissionSettings(#[source] std::io::Error),
    #[error("media transport failed: {0}")]
    Transport(String),
    #[error("media worker stopped during startup")]
    Startup,
    #[error("capture and encoding did not produce the first video packet within 5 seconds")]
    FirstFrameTimeout,
    /// The video encoder was open but never emitted a packet. Capture that never
    /// produces a frame stays [`Self::FirstFrameTimeout`].
    #[error("the video encoder produced no packet within 5 seconds")]
    EncoderStall,
}

impl MediaError {
    /// `"encoder"` asks the viewer to open a new peer with the next common codec.
    /// Permission, display, transport, and audio failures stay unclassified.
    pub(crate) fn fallback_reason(&self) -> Option<&'static str> {
        match self {
            Self::VideoEncoder(_) | Self::EncoderStall => Some("encoder"),
            _ => None,
        }
    }
}

/// Video codec support is probed only when explicitly requested.
pub async fn supported_video_codecs(display_id: u32) -> Result<Vec<String>, MediaError> {
    tokio::task::spawn_blocking(move || {
        if !deskfleet_capture::displays()?
            .iter()
            .any(|display| display.id == display_id)
        {
            return Err(MediaError::DisplayNotFound(display_id));
        }
        Ok(deskfleet_encoder::supported_codecs(display_id)?
            .into_iter()
            .map(|codec| codec.as_str().to_owned())
            .collect())
    })
    .await?
}

/// Enumerating displays can require a graphical session and capture permission.
pub async fn displays() -> Result<Vec<Display>, MediaError> {
    Ok(tokio::task::spawn_blocking(deskfleet_capture::displays).await??)
}

/// Check capture permission on a worker without prompting or starting capture.
///
/// Returns `None` on platforms without an upfront permission request.
///
/// # Errors
/// Returns an error if the permission worker fails.
pub async fn check_screen_capture_access() -> Result<Option<bool>, MediaError> {
    Ok(tokio::task::spawn_blocking(deskfleet_capture::check_screen_capture_access).await?)
}

/// Request capture permission on a worker without starting capture or encoders.
/// Opens the macOS privacy pane when access remains denied.
///
/// Returns `None` on platforms without an upfront permission request.
///
/// # Errors
///
/// Returns an error if the permission worker or System Settings fails.
pub async fn request_screen_capture_access() -> Result<Option<bool>, MediaError> {
    tokio::task::spawn_blocking(|| {
        let granted = deskfleet_capture::request_screen_capture_access();
        #[cfg(target_os = "macos")]
        if granted == Some(false) {
            crate::permission_settings::open("Privacy_ScreenCapture")
                .map_err(MediaError::PermissionSettings)?;
        }
        Ok(granted)
    })
    .await?
}

#[derive(Debug, Clone)]
pub struct DesktopConfig {
    pub display_id: u32,
    pub fps: f64,
    pub bitrate_bps: u32,
    pub max_bitrate_bps: u32,
}

impl DesktopConfig {
    fn validate(&self) -> Result<(), MediaError> {
        if !self.fps.is_finite() || !(1.0..=240.0).contains(&self.fps) {
            return Err(MediaError::InvalidConfig("fps must be between 1 and 240"));
        }
        if self.bitrate_bps == 0
            || (self.max_bitrate_bps != 0 && self.max_bitrate_bps < self.bitrate_bps)
        {
            return Err(MediaError::InvalidConfig(
                "bitrate must be positive and no greater than the nonzero maximum",
            ));
        }
        Ok(())
    }
}

enum Packet {
    Video(Vec<u8>, Duration),
    Audio(Vec<u8>, Duration),
}

/// Owns a single capture pipeline. Explicit stop joins both workers; drop also
/// cancels delivery and wakes a producer blocked on a full queue.
pub struct DesktopStream {
    stop: Arc<AtomicBool>,
    shutdown: Option<watch::Sender<()>>,
    capture: Option<JoinHandle<Result<(), MediaError>>>,
    delivery: Option<JoinHandle<Result<(), MediaError>>>,
}

impl DesktopStream {
    /// Start capture for the peer's negotiated codec and audio configuration.
    pub async fn start(peer: Arc<Peer>, config: DesktopConfig) -> Result<Self, MediaError> {
        config.validate()?;
        let codec = match peer.video_codec() {
            Some(VideoCodec::H264) => Codec::H264,
            Some(VideoCodec::H265) => Codec::H265,
            Some(VideoCodec::Av1) => Codec::AV1,
            None => return Err(MediaError::InvalidConfig("peer has no video track")),
        };
        let audio = peer.has_audio();
        let stop = Arc::new(AtomicBool::new(false));
        let (shutdown, mut shutdown_rx) = watch::channel(());
        let (packets, mut packet_rx) = mpsc::channel(8);
        let (ready, startup) = oneshot::channel();
        let capture_stop = Arc::clone(&stop);
        let capture_peer = Arc::clone(&peer);
        let capture = tokio::task::spawn_blocking(move || {
            let result = capture_loop(
                config,
                codec,
                audio,
                capture_stop,
                Arc::clone(&capture_peer),
                packets,
                ready,
            );
            if let Err(error) = &result {
                capture_peer.report_media_error(error.to_string(), error.fallback_reason());
            }
            result
        });
        let delivery_stop = Arc::clone(&stop);
        let delivery = tokio::spawn(async move {
            let result: Result<(), MediaError> = async {
                loop {
                    tokio::select! {
                        biased;
                        _ = shutdown_rx.changed() => return Ok(()),
                        packet = packet_rx.recv() => {
                            let Some(packet) = packet else { return Ok(()) };
                            let write = async {
                                match packet {
                                    Packet::Video(data, duration) => peer.write_video(data.into(), duration).await,
                                    Packet::Audio(data, duration) => peer.write_audio(data.into(), duration).await,
                                }.map_err(|error| MediaError::Transport(error.to_string()))
                            };
                            tokio::select! {
                                biased;
                                _ = shutdown_rx.changed() => return Ok(()),
                                result = write => result?,
                            }
                        }
                    }
                }
            }.await;
            delivery_stop.store(true, Ordering::Relaxed);
            if let Err(error) = &result {
                peer.report_media_error(error.to_string(), error.fallback_reason());
            }
            result
        });
        let stream = Self {
            stop,
            shutdown: Some(shutdown),
            capture: Some(capture),
            delivery: Some(delivery),
        };
        match startup.await {
            Ok(()) => Ok(stream),
            Err(_) => {
                stream.stop().await?;
                Err(MediaError::Startup)
            }
        }
    }

    pub fn is_finished(&self) -> bool {
        self.capture.as_ref().is_none_or(JoinHandle::is_finished)
            || self.delivery.as_ref().is_none_or(JoinHandle::is_finished)
    }

    /// Stop delivery before joining the producer, so a full queue cannot deadlock shutdown.
    pub async fn stop(mut self) -> Result<(), MediaError> {
        self.stop.store(true, Ordering::Relaxed);
        self.shutdown.take();
        let delivery = match self.delivery.take() {
            Some(handle) => handle
                .await
                .map_err(MediaError::from)
                .and_then(|result| result),
            None => Ok(()),
        };
        let capture = match self.capture.take() {
            Some(handle) => handle
                .await
                .map_err(MediaError::from)
                .and_then(|result| result),
            None => Ok(()),
        };
        capture.and(delivery)
    }
}

impl Drop for DesktopStream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.shutdown.take();
        if let Some(delivery) = &self.delivery {
            delivery.abort();
        }
    }
}

fn capture_loop(
    config: DesktopConfig,
    codec: Codec,
    audio: bool,
    stop: Arc<AtomicBool>,
    peer: Arc<Peer>,
    packets: mpsc::Sender<Packet>,
    ready: oneshot::Sender<()>,
) -> Result<(), MediaError> {
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
    let mut opus = audio
        .then(|| OpusEncoder::new(&OpusEncoderConfig::default()))
        .transpose()?;
    let mut encoder: Option<Encoder> = None;
    let mut retained = RetainedVideoFrame::new();
    let mut dimensions = (0, 0);
    let mut ready = Some(ready);
    let first_frame_deadline = Instant::now() + Duration::from_secs(5);
    let result = (|| {
        while !stop.load(Ordering::Relaxed) {
            if ready.is_some() && Instant::now() >= first_frame_deadline {
                return Err(if encoder.is_some() {
                    MediaError::EncoderStall
                } else {
                    MediaError::FirstFrameTimeout
                });
            }
            let captured = capture.poll_frame()?;
            if let Some(frame) = captured.as_ref()
                && dimensions != (frame.width, frame.height)
            {
                encoder = Some(
                    Encoder::new(&EncoderConfig {
                        width: frame.width,
                        height: frame.height,
                        fps,
                        codec,
                        bitrate_bps: config.bitrate_bps,
                        max_bitrate_bps: config.max_bitrate_bps,
                        h264_profile: H264Profile::ConstrainedBaseline,
                        ..EncoderConfig::default()
                    })
                    .map_err(MediaError::VideoEncoder)?,
                );
                dimensions = (frame.width, frame.height);
            }
            // Keep one owned surface outside the capture pool. PLI/FIR can
            // arrive after the desktop stops changing, so consume requests on
            // every bounded capture poll and re-encode that retained frame.
            let keyframe = peer.take_keyframe_request();
            let captured = captured.map(|frame| {
                let timestamp = frame.timestamp_ns;
                (frame, timestamp)
            });
            if let Some(encoded) = retained.submit(
                captured,
                keyframe,
                Instant::now(),
                |frame, timestamp, keyframe| -> Result<_, MediaError> {
                    frame.timestamp_ns = timestamp;
                    let encoder = encoder.as_mut().ok_or(MediaError::Startup)?;
                    if keyframe {
                        encoder.request_keyframe();
                    }
                    encoder.encode(frame).map_err(MediaError::VideoEncoder)
                },
            ) && !deliver_video(encoded?, &packets, &mut ready, fps)
            {
                return Ok(());
            }
            // Hardware MFTs can produce their first or last packet after encode
            // returns, including when a static desktop never supplies another frame.
            if let Some(encoder) = encoder.as_mut()
                && !deliver_video(
                    encoder.poll_output().map_err(MediaError::VideoEncoder)?,
                    &packets,
                    &mut ready,
                    fps,
                )
            {
                return Ok(());
            }
            // Drain audio even when there is no new video frame (a static desktop).
            if let Some(opus) = opus.as_mut() {
                while let Some(frame) = capture.try_next_audio_frame()? {
                    for packet in opus.encode(&frame.samples)? {
                        if packets
                            .blocking_send(Packet::Audio(
                                packet.data,
                                Duration::from_nanos(packet.duration_ns),
                            ))
                            .is_err()
                        {
                            return Ok(());
                        }
                    }
                }
            }
        }
        Ok(())
    })();
    // Release encoder registrations while their capture textures still exist.
    // The Linux stub has no destructor, so `drop(encoder)` fails clippy there.
    // Ending this scope still drops Windows and macOS encoders before stop.
    {
        let _encoder = encoder.take();
    }
    let _ = retained.latest.take();
    let stopped = capture.stop().map_err(MediaError::from);
    result.and(stopped)
}

/// Holds exactly one capture-owned surface until a newer frame replaces it.
/// The generic frame lets scheduling and ownership be exercised without a GPU.
struct RetainedVideoFrame<T> {
    latest: Option<(T, u64, Instant)>,
    last_timestamp: Option<u64>,
    keyframe_requested: bool,
}

impl<T> RetainedVideoFrame<T> {
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

fn deliver_video(
    encoded: Vec<EncodedPacket>,
    packets: &mpsc::Sender<Packet>,
    ready: &mut Option<oneshot::Sender<()>>,
    fps: f64,
) -> bool {
    for packet in encoded {
        if packet.data.is_empty() {
            continue;
        }
        let duration = if packet.duration_ns == 0 {
            Duration::from_secs_f64(1.0 / fps)
        } else {
            Duration::from_nanos(packet.duration_ns)
        };
        if packets
            .blocking_send(Packet::Video(packet.data, duration))
            .is_err()
        {
            return false;
        }
        if let Some(ready) = ready.take() {
            let _ = ready.send(());
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn startup_waits_for_nonempty_output_and_delivery() {
        let (packets, mut receiver) = mpsc::channel(2);
        let (sender, mut started) = oneshot::channel();
        let mut ready = Some(sender);
        assert!(deliver_video(Vec::new(), &packets, &mut ready, 30.0));
        assert!(matches!(
            started.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        let mut packet = EncodedPacket {
            data: Vec::new(),
            timestamp_ns: 0,
            duration_ns: 0,
            is_keyframe: true,
        };
        assert!(deliver_video(
            vec![packet.clone()],
            &packets,
            &mut ready,
            30.0
        ));
        assert!(matches!(
            started.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        packet.data = vec![0, 0, 0, 1, 0x65];
        assert!(deliver_video(vec![packet], &packets, &mut ready, 30.0));
        assert!(started.try_recv().is_ok());
        let Packet::Video(bytes, duration) = receiver.try_recv().unwrap() else {
            panic!("expected video")
        };
        assert_eq!(bytes, [0, 0, 0, 1, 0x65]);
        assert_eq!(duration, Duration::from_secs_f64(1.0 / 30.0));
        drop(receiver);
        let (sender, mut started) = oneshot::channel();
        let mut ready = Some(sender);
        assert!(!deliver_video(
            vec![EncodedPacket {
                data: bytes,
                timestamp_ns: 0,
                duration_ns: 0,
                is_keyframe: true
            }],
            &packets,
            &mut ready,
            30.0
        ));
        assert!(matches!(
            started.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn invalid_settings_fail_before_capture() {
        let mut config = DesktopConfig {
            display_id: 0,
            fps: 60.0,
            bitrate_bps: 8_000_000,
            max_bitrate_bps: 0,
        };
        for fps in [f64::NAN, f64::INFINITY, 0.0, -1.0, 241.0] {
            config.fps = fps;
            assert!(config.validate().is_err());
        }
        config.fps = 60.0;
        config.max_bitrate_bps = 1;
        assert!(config.validate().is_err());
        config.max_bitrate_bps = 0;
        assert!(config.validate().is_ok());
    }

    #[test]
    fn only_video_encoder_failures_name_another_codec() {
        use deskfleet_encoder::EncoderError;

        assert_eq!(
            MediaError::VideoEncoder(EncoderError::Unsupported("nvenc")).fallback_reason(),
            Some("encoder")
        );
        assert_eq!(MediaError::EncoderStall.fallback_reason(), Some("encoder"));
        assert_eq!(
            MediaError::Encoder(EncoderError::Unsupported("opus")).fallback_reason(),
            None
        );
        for error in [
            MediaError::FirstFrameTimeout,
            MediaError::DisplayNotFound(1),
            MediaError::Transport("write failed".to_owned()),
            MediaError::Startup,
            MediaError::InvalidConfig("fps must be between 1 and 240"),
        ] {
            assert_eq!(error.fallback_reason(), None);
        }
    }
}
