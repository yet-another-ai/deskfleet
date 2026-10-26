//! Generated pixels exercise hardware encoding without accessing a desktop.
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

    let settings = EncoderSettings {
        codec: match codec {
            VideoCodec::H264 => Codec::H264,
            VideoCodec::H265 => Codec::H265,
            VideoCodec::Av1 => Codec::Av1,
        },
        width: 320,
        height: 240,
        fps: 10.0,
        bitrate_bps: 1_000_000,
        max_bitrate_bps: 0,
        profile: if codec == VideoCodec::H264 {
            "constrained-baseline"
        } else {
            "main"
        },
    };
    let pixels = [0u8, 0, 255, 255].repeat(320 * 240);
    let (mut encoder, mut packets) = Encoder::start(&settings, &pixels, 0)?;
    let mut timestamp_ns = 0;
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
        std::thread::sleep(Duration::from_millis(100));
        if stop.load(Ordering::Relaxed) {
            break;
        }
        if keyframe.swap(false, Ordering::Relaxed) {
            encoder.request_keyframe();
        }
        timestamp_ns += 100_000_000;
        packets = encoder.encode(&pixels, timestamp_ns)?;
    }
    Ok(())
}
