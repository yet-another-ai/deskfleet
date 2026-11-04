//! On-demand capture → hardware encode → WebRTC, adapted from desk-fleet's streamer.
//!
//! Capture and encoders live on one worker thread. Only encoded packets cross the
//! bounded queue; native surfaces never cross the Node-API boundary.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use deskfleet_capture::{CaptureError, Display};
use deskfleet_encoder::{Codec, EncoderError};

pub(crate) mod pipeline;
use pipeline::{CaptureBatch, CapturePipeline};
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
    #[error("Windows desktop service: {message}")]
    Service { message: String, encoder: bool },
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
            Self::VideoEncoder(_) | Self::EncoderStall | Self::Service { encoder: true, .. } => {
                Some("encoder")
            }
            _ => None,
        }
    }
}

/// Video codec support is probed only when explicitly requested.
pub async fn supported_video_codecs(display_id: u32) -> Result<Vec<String>, MediaError> {
    tokio::task::spawn_blocking(move || {
        #[cfg(windows)]
        if let Some(mut client) = crate::windows_desktop::Client::connect()? {
            return client.codecs(display_id);
        }
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
    #[cfg(target_os = "linux")]
    if deskfleet_linux_desktop::backend() == deskfleet_linux_desktop::Backend::Wayland {
        deskfleet_wayland::restore_access()
            .await
            .map_err(|error| CaptureError::Platform(error.to_string()))?;
    }
    tokio::task::spawn_blocking(|| {
        #[cfg(windows)]
        if let Some(mut client) = crate::windows_desktop::Client::connect()? {
            return client.displays();
        }
        Ok(deskfleet_capture::displays()?)
    })
    .await?
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
#[cfg_attr(any(windows, test), derive(serde::Serialize, serde::Deserialize))]
pub struct DesktopConfig {
    pub display_id: u32,
    pub fps: f64,
    pub bitrate_bps: u32,
    pub max_bitrate_bps: u32,
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
}

impl DesktopConfig {
    pub(crate) fn validate(&self) -> Result<(), MediaError> {
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
        match (self.max_width, self.max_height) {
            (None, None) | (Some(2..), Some(2..)) => {}
            _ => {
                return Err(MediaError::InvalidConfig(
                    "both video bounds must be at least 2",
                ));
            }
        }
        Ok(())
    }

    /// Fit within the requested box without upscaling; hardware codecs use even dimensions.
    pub(crate) fn output_dimensions(&self, width: u32, height: u32) -> (u32, u32) {
        let (Some(max_width), Some(max_height)) = (self.max_width, self.max_height) else {
            return (width, height);
        };
        let width = u64::from(width.max(2));
        let height = u64::from(height.max(2));
        let max_width = u64::from(max_width).min(width);
        let max_height = u64::from(max_height).min(height);
        let (width, height) = if max_width * height <= max_height * width {
            (max_width, height * max_width / width)
        } else {
            (width * max_height / height, max_height)
        };
        // Each result is bounded by its original u32 input.
        (((width as u32) & !1).max(2), ((height as u32) & !1).max(2))
    }
}

pub(crate) enum Packet {
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

enum CaptureSource {
    Local(Box<CapturePipeline>),
    #[cfg(windows)]
    Service(crate::windows_desktop::Client),
}

impl CaptureSource {
    fn open(config: DesktopConfig, codec: Codec, audio: bool) -> Result<Self, MediaError> {
        #[cfg(windows)]
        if let Some(mut client) = crate::windows_desktop::Client::connect()? {
            if audio {
                return Err(MediaError::InvalidConfig(
                    "Windows system audio is unavailable",
                ));
            }
            client.start(config, codec)?;
            return Ok(Self::Service(client));
        }
        Ok(Self::Local(Box::new(CapturePipeline::new(
            config, codec, audio,
        )?)))
    }

    fn poll(&mut self, keyframe: bool) -> Result<CaptureBatch, MediaError> {
        match self {
            Self::Local(pipeline) => pipeline.poll(keyframe),
            #[cfg(windows)]
            Self::Service(client) => client.poll(keyframe),
        }
    }

    fn stop(self) -> Result<(), MediaError> {
        match self {
            Self::Local(pipeline) => (*pipeline).stop(),
            #[cfg(windows)]
            Self::Service(mut client) => client.stop(),
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
    let mut source = CaptureSource::open(config, codec, audio)?;
    let mut ready = Some(ready);
    let first_frame_deadline = Instant::now() + Duration::from_secs(5);
    let mut encoder_started = false;
    let result = (|| {
        while !stop.load(Ordering::Relaxed) {
            if ready.is_some() && Instant::now() >= first_frame_deadline {
                return Err(if encoder_started {
                    MediaError::EncoderStall
                } else {
                    MediaError::FirstFrameTimeout
                });
            }
            let batch = source.poll(peer.take_keyframe_request())?;
            encoder_started = batch.encoder_started;
            if !deliver_packets(batch.packets, &packets, &mut ready) {
                return Ok(());
            }
        }
        Ok(())
    })();
    result.and(source.stop())
}

fn deliver_packets(
    encoded: Vec<Packet>,
    packets: &mpsc::Sender<Packet>,
    ready: &mut Option<oneshot::Sender<()>>,
) -> bool {
    for packet in encoded {
        let video = matches!(&packet, Packet::Video(data, _) if !data.is_empty());
        let empty = match &packet {
            Packet::Video(data, _) | Packet::Audio(data, _) => data.is_empty(),
        };
        if empty {
            continue;
        }
        if packets.blocking_send(packet).is_err() {
            return false;
        }
        if video && let Some(ready) = ready.take() {
            let _ = ready.send(());
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_waits_for_nonempty_video_output_and_delivery() {
        let (packets, mut receiver) = mpsc::channel(2);
        let (sender, mut started) = oneshot::channel();
        let mut ready = Some(sender);
        assert!(deliver_packets(
            vec![Packet::Video(Vec::new(), Duration::ZERO)],
            &packets,
            &mut ready
        ));
        assert!(deliver_packets(
            vec![Packet::Audio(vec![1], Duration::from_millis(20))],
            &packets,
            &mut ready
        ));
        assert!(matches!(
            started.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(deliver_packets(
            vec![Packet::Video(
                vec![0, 0, 0, 1, 0x65],
                Duration::from_millis(33)
            )],
            &packets,
            &mut ready
        ));
        assert!(started.try_recv().is_ok());
        assert!(matches!(receiver.try_recv().unwrap(), Packet::Audio(..)));
        let Packet::Video(bytes, duration) = receiver.try_recv().unwrap() else {
            panic!("expected video")
        };
        assert_eq!(bytes, [0, 0, 0, 1, 0x65]);
        assert_eq!(duration, Duration::from_millis(33));
        drop(receiver);
        let (sender, mut started) = oneshot::channel();
        let mut ready = Some(sender);
        assert!(!deliver_packets(
            vec![Packet::Video(bytes, duration)],
            &packets,
            &mut ready
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
            max_width: None,
            max_height: None,
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
        config.max_width = Some(320);
        assert!(config.validate().is_err());
        config.max_height = Some(1);
        assert!(config.validate().is_err());
        config.max_height = Some(180);
        assert!(config.validate().is_ok());
    }

    #[test]
    fn preview_dimensions_fit_landscape_portrait_and_small_displays() {
        let config = DesktopConfig {
            display_id: 0,
            fps: 1.0,
            bitrate_bps: 150_000,
            max_bitrate_bps: 0,
            max_width: Some(320),
            max_height: Some(180),
        };
        assert_eq!(config.output_dimensions(3840, 2160), (320, 180));
        assert_eq!(config.output_dimensions(1920, 1200), (288, 180));
        assert_eq!(config.output_dimensions(1080, 1920), (100, 180));
        assert_eq!(config.output_dimensions(101, 77), (100, 76));
        assert_eq!(config.output_dimensions(6400, 1080), (320, 54));
        assert_eq!(config.output_dimensions(u32::MAX, u32::MAX), (180, 180));
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
