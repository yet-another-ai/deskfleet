//! Generated pixels exercise hardware encoding without accessing a desktop.
//! DESKFLEET_SMOKE_FPS selects a 1–240 fps source rate (10 fps by default).
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};

use deskfleet_native::rtc::VideoCodec;
use tokio::sync::mpsc;

pub struct Packet {
    pub data: Vec<u8>,
    pub duration: Duration,
}

pub struct HardwareStream {
    packets: mpsc::Receiver<Result<Packet, String>>,
    stop: Arc<AtomicBool>,
    keyframe: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl HardwareStream {
    pub fn start(codec: VideoCodec) -> Result<Self, String> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = codec;
            Err("generated hardware media smoke is supported on Linux".into())
        }
        #[cfg(target_os = "linux")]
        {
            let (sender, packets) = mpsc::channel(4);
            let stop = Arc::new(AtomicBool::new(false));
            let keyframe = Arc::new(AtomicBool::new(false));
            let worker_stop = stop.clone();
            let worker_keyframe = keyframe.clone();
            let worker = std::thread::Builder::new()
                .name("hardware-media-smoke".into())
                .spawn(move || {
                    if let Err(error) = generate(codec, &sender, &worker_stop, &worker_keyframe) {
                        let _ = sender.blocking_send(Err(error.to_string()));
                    }
                })
                .map_err(|error| error.to_string())?;
            Ok(Self {
                packets,
                stop,
                keyframe,
                worker: Some(worker),
            })
        }
    }

    pub async fn next_packet(&mut self) -> Result<Packet, String> {
        self.packets
            .recv()
            .await
            .ok_or("hardware encoder worker ended")?
    }

    pub fn request_keyframe(&self) {
        self.keyframe.store(true, Ordering::Relaxed);
    }

    pub async fn stop(mut self) -> Result<(), String> {
        self.stop.store(true, Ordering::Relaxed);
        self.packets.close();
        if let Some(worker) = self.worker.take() {
            tokio::task::spawn_blocking(move || worker.join())
                .await
                .map_err(|error| error.to_string())?
                .map_err(|_| "hardware encoder worker panicked".to_owned())?;
        }
        Ok(())
    }
}

impl Drop for HardwareStream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.packets.close();
    }
}

#[cfg(target_os = "linux")]
fn generate(
    codec: VideoCodec,
    sender: &mpsc::Sender<Result<Packet, String>>,
    stop: &AtomicBool,
    keyframe: &AtomicBool,
) -> deskfleet_linux_media::Result<()> {
    use deskfleet_linux_media::{Codec, Encoder, EncoderSettings};
    use std::time::Instant;

    let configured_fps = match std::env::var("DESKFLEET_SMOKE_FPS") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(error) => return Err(deskfleet_linux_media::Error::Pipeline(error.to_string())),
    };
    let fps = parse_fps(configured_fps.as_deref())
        .map_err(|error| deskfleet_linux_media::Error::Pipeline(error.into()))?;

    let settings = EncoderSettings {
        codec: match codec {
            VideoCodec::H264 => Codec::H264,
            VideoCodec::H265 => Codec::H265,
            VideoCodec::Av1 => Codec::Av1,
        },
        width: 320,
        height: 240,
        fps,
        bitrate_bps: 1_000_000,
        max_bitrate_bps: 0,
        profile: if codec == VideoCodec::H264 {
            "constrained-baseline"
        } else {
            "main"
        },
    };
    let pixels = [0u8, 0, 255, 255].repeat(320 * 240);
    let origin = Instant::now();
    let period = Duration::from_secs_f64(1.0 / fps);
    let (mut encoder, mut packets) = Encoder::start(&settings, &pixels, 0)?;
    while !stop.load(Ordering::Relaxed) {
        for packet in packets {
            if sender
                .blocking_send(Ok(Packet {
                    data: packet.data,
                    duration: Duration::from_nanos(packet.duration_ns),
                }))
                .is_err()
            {
                return Ok(());
            }
        }
        // Anchor capture to the original clock, so encoding and packet delivery
        // consume the interval instead of being added to a fixed sleep. Skip
        // missed slots after a stall rather than generating a catch-up burst.
        let now = Instant::now();
        let deadline = now + until_next_slot(now.duration_since(origin), period);
        std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
        if stop.load(Ordering::Relaxed) {
            break;
        }
        if keyframe.swap(false, Ordering::Relaxed) {
            encoder.request_keyframe();
        }
        let timestamp_ns = u64::try_from(origin.elapsed().as_nanos()).unwrap_or(u64::MAX);
        packets = encoder.encode(&pixels, timestamp_ns)?;
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn parse_fps(value: Option<&str>) -> Result<f64, &'static str> {
    let fps = match value {
        Some(value) => value
            .parse()
            .map_err(|_| "DESKFLEET_SMOKE_FPS must be a number between 1 and 240")?,
        None => 10.0,
    };
    if !f64::is_finite(fps) || !(1.0..=240.0).contains(&fps) {
        return Err("DESKFLEET_SMOKE_FPS must be a number between 1 and 240");
    }
    Ok(fps)
}

#[cfg(any(target_os = "linux", test))]
fn until_next_slot(elapsed: Duration, period: Duration) -> Duration {
    // The validated 1–240 fps range keeps the remainder below one second.
    let remainder = (elapsed.as_nanos() % period.as_nanos()) as u64;
    period - Duration::from_nanos(remainder)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_rate_defaults_and_rejects_invalid_inputs() {
        assert_eq!(parse_fps(None), Ok(10.0));
        for value in ["1", "59.94", "60", "240"] {
            assert!(parse_fps(Some(value)).is_ok());
        }
        for value in ["", "NaN", "inf", "0", "-1", "240.1", "60fps"] {
            assert!(parse_fps(Some(value)).is_err());
        }
    }

    #[test]
    fn encoding_cost_uses_the_frame_interval_and_stalls_skip_old_slots() {
        let period = Duration::from_millis(20);
        assert_eq!(
            until_next_slot(Duration::from_millis(7), period),
            Duration::from_millis(13)
        );
        assert_eq!(
            until_next_slot(Duration::from_millis(27), period),
            Duration::from_millis(13)
        );
        assert_eq!(
            until_next_slot(Duration::from_millis(94), period),
            Duration::from_millis(6)
        );
    }
}
