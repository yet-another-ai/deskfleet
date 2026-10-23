//! On-demand capture → hardware encode → WebRTC, adapted from desk-fleet's streamer.
//!
//! Capture and encoders live on one worker thread. Only encoded packets cross the
//! bounded queue; native surfaces never cross the Node-API boundary.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use deskfleet_capture::{CaptureConfig, CaptureError, Display};
use deskfleet_encoder::{
    Codec, Encoder, EncoderConfig, EncoderError, H264Profile, OpusEncoder, OpusEncoderConfig,
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
    #[error("media worker failed: {0}")]
    Worker(#[from] tokio::task::JoinError),
    #[error("media transport failed: {0}")]
    Transport(String),
    #[error("media worker stopped during startup")]
    Startup,
    #[error("capture did not produce its first frame within 5 seconds")]
    FirstFrameTimeout,
}

/// Video codec support is probed only when explicitly requested.
pub async fn supported_video_codecs() -> Result<Vec<String>, MediaError> {
    Ok(tokio::task::spawn_blocking(|| {
        deskfleet_encoder::supported_codecs()
            .into_iter()
            .map(|codec| codec.as_str().to_owned())
            .collect()
    })
    .await?)
}

/// Enumerating displays can require a graphical session and capture permission.
pub async fn displays() -> Result<Vec<Display>, MediaError> {
    Ok(tokio::task::spawn_blocking(deskfleet_capture::displays).await??)
}

/// Request capture permission on a worker without starting capture or encoders.
///
/// Returns `None` on platforms without an upfront permission request.
///
/// # Errors
///
/// Returns an error if the permission worker fails.
pub async fn request_screen_capture_access() -> Result<Option<bool>, MediaError> {
    Ok(tokio::task::spawn_blocking(deskfleet_capture::request_screen_capture_access).await?)
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
                capture_peer.report_media_error(error.to_string());
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
                peer.report_media_error(error.to_string());
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
    let mut dimensions = (0, 0);
    let mut ready = Some(ready);
    let first_frame_deadline = Instant::now() + Duration::from_secs(5);
    let result = (|| {
        while !stop.load(Ordering::Relaxed) {
            if encoder.is_none() && Instant::now() >= first_frame_deadline {
                return Err(MediaError::FirstFrameTimeout);
            }
            if let Some(frame) = capture.poll_frame()? {
                if dimensions != (frame.width, frame.height) {
                    encoder = Some(Encoder::new(&EncoderConfig {
                        width: frame.width,
                        height: frame.height,
                        fps,
                        codec,
                        bitrate_bps: config.bitrate_bps,
                        max_bitrate_bps: config.max_bitrate_bps,
                        h264_profile: H264Profile::ConstrainedBaseline,
                        ..EncoderConfig::default()
                    })?);
                    dimensions = (frame.width, frame.height);
                }
                if let Some(encoder) = encoder.as_mut() {
                    if peer.take_keyframe_request() {
                        encoder.request_keyframe();
                    }
                    let encoded = encoder.encode(&frame)?;
                    if let Some(ready) = ready.take() {
                        let _ = ready.send(());
                    }
                    for packet in encoded {
                        let duration = if packet.duration_ns == 0 {
                            Duration::from_secs_f64(1.0 / fps)
                        } else {
                            Duration::from_nanos(packet.duration_ns)
                        };
                        if packets
                            .blocking_send(Packet::Video(packet.data, duration))
                            .is_err()
                        {
                            return Ok(());
                        }
                    }
                }
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
    let stopped = capture.stop().map_err(MediaError::from);
    result.and(stopped)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
