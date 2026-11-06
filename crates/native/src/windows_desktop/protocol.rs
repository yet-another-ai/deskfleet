//! Bounded metadata frames followed by raw encoded packet bytes.

use std::io::{self, Read, Write};
use std::time::Duration;

use deskfleet_capture::Display;
use deskfleet_encoder::Codec;
use deskfleet_input::InputEvent;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::media::{DesktopConfig, Packet};

const MAX_MESSAGE: usize = 64 * 1024;
const MAX_PACKET: usize = 32 * 1024 * 1024;
const MAX_BATCH: usize = 64 * 1024 * 1024;
const MAX_PACKETS: usize = 256;

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Request {
    Displays,
    Codecs {
        display_id: u32,
    },
    Start {
        config: DesktopConfig,
        codec: VideoCodec,
    },
    Poll {
        keyframe: bool,
        /// Congestion-control target in bits/sec for live encoder retargeting.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_bitrate_bps: Option<u32>,
        /// Stop submitting raw video while the transport is behind.
        video_paused: bool,
    },
    InputStart {
        display_id: u32,
    },
    Input {
        event: InputEvent,
    },
    RefreshInput,
    Stop,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum VideoCodec {
    H264,
    H265,
    Av1,
}

impl From<Codec> for VideoCodec {
    fn from(codec: Codec) -> Self {
        match codec {
            Codec::H264 => Self::H264,
            Codec::H265 => Self::H265,
            Codec::AV1 => Self::Av1,
        }
    }
}

impl From<VideoCodec> for Codec {
    fn from(codec: VideoCodec) -> Self {
        match codec {
            VideoCodec::H264 => Self::H264,
            VideoCodec::H265 => Self::H265,
            VideoCodec::Av1 => Self::AV1,
        }
    }
}

#[derive(Serialize, Deserialize)]
pub(super) struct DisplayInfo {
    id: u32,
    width: u32,
    height: u32,
    refresh_rate_hz: f64,
}

impl From<Display> for DisplayInfo {
    fn from(display: Display) -> Self {
        Self {
            id: display.id,
            width: display.width,
            height: display.height,
            refresh_rate_hz: display.refresh_rate_hz,
        }
    }
}

impl From<DisplayInfo> for Display {
    fn from(display: DisplayInfo) -> Self {
        Self {
            id: display.id,
            width: display.width,
            height: display.height,
            refresh_rate_hz: display.refresh_rate_hz,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Reply {
    Ready,
    Displays {
        displays: Vec<DisplayInfo>,
    },
    Codecs {
        codecs: Vec<String>,
    },
    Batch {
        packets: Vec<PacketInfo>,
        encoder_started: bool,
    },
    Error {
        message: String,
        encoder: bool,
    },
}

#[derive(Serialize, Deserialize)]
pub(super) struct PacketInfo {
    video: bool,
    keyframe: bool,
    length: u32,
    duration_ns: u64,
    timestamp_ns: u64,
}

pub(super) fn write_json(writer: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    let data = serde_json::to_vec(value).map_err(io::Error::other)?;
    if data.len() > MAX_MESSAGE {
        return Err(invalid("desktop IPC metadata exceeds its limit"));
    }
    writer.write_all(&(data.len() as u32).to_le_bytes())?;
    writer.write_all(&data)?;
    writer.flush()
}

pub(super) fn read_json<T: DeserializeOwned>(reader: &mut impl Read) -> io::Result<T> {
    let mut length = [0; 4];
    reader.read_exact(&mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_MESSAGE {
        return Err(invalid("invalid desktop IPC metadata length"));
    }
    let mut data = vec![0; length];
    reader.read_exact(&mut data)?;
    serde_json::from_slice(&data).map_err(|error| invalid(error.to_string()))
}

fn validate_packets(packets: &[PacketInfo]) -> io::Result<()> {
    if packets.len() > MAX_PACKETS {
        return Err(invalid("too many desktop packets"));
    }
    let mut total = 0usize;
    for packet in packets {
        let length = packet.length as usize;
        if length == 0 || length > MAX_PACKET {
            return Err(invalid("invalid desktop packet size"));
        }
        total = total
            .checked_add(length)
            .ok_or_else(|| invalid("desktop packet size overflow"))?;
        if total > MAX_BATCH {
            return Err(invalid("desktop packet batch exceeds its limit"));
        }
        if packet.duration_ns == 0 || packet.duration_ns > 1_000_000_000 {
            return Err(invalid("invalid desktop packet duration"));
        }
    }
    Ok(())
}

pub(super) fn write_batch(
    writer: &mut impl Write,
    packets: Vec<Packet>,
    encoder_started: bool,
) -> io::Result<()> {
    let metadata: Vec<_> = packets
        .iter()
        .map(|packet| {
            let (video, data, duration, timestamp_ns, keyframe) = match packet {
                Packet::Video(data, duration, timestamp_ns, keyframe) => {
                    (true, data, duration, *timestamp_ns, *keyframe)
                }
                Packet::Audio(data, duration) => (false, data, duration, 0, false),
            };
            Ok(PacketInfo {
                video,
                keyframe,
                length: u32::try_from(data.len())
                    .map_err(|_| invalid("desktop packet is too large"))?,
                duration_ns: u64::try_from(duration.as_nanos())
                    .map_err(|_| invalid("desktop packet duration overflow"))?,
                timestamp_ns,
            })
        })
        .collect::<io::Result<_>>()?;
    validate_packets(&metadata)?;
    write_json(
        writer,
        &Reply::Batch {
            packets: metadata,
            encoder_started,
        },
    )?;
    for packet in packets {
        let (Packet::Video(data, ..) | Packet::Audio(data, _)) = packet;
        writer.write_all(&data)?;
    }
    writer.flush()
}

pub(super) fn read_packets(
    reader: &mut impl Read,
    packets: Vec<PacketInfo>,
) -> io::Result<Vec<Packet>> {
    validate_packets(&packets)?;
    packets
        .into_iter()
        .map(|packet| {
            let mut data = vec![0; packet.length as usize];
            reader.read_exact(&mut data)?;
            let duration = Duration::from_nanos(packet.duration_ns);
            Ok(if packet.video {
                Packet::Video(data.into(), duration, packet.timestamp_ns, packet.keyframe)
            } else {
                Packet::Audio(data.into(), duration)
            })
        })
        .collect()
}

fn invalid(message: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn binary_packets_roundtrip_without_json_encoding_video() {
        let bytes = vec![0, 0, 0, 1, 0xff, 0x65];
        let duration = Duration::from_millis(33);
        let timestamp_ns = 7_000_000_000;
        let mut wire = Vec::new();
        write_batch(
            &mut wire,
            vec![Packet::Video(
                bytes.clone().into(),
                duration,
                timestamp_ns,
                true,
            )],
            true,
        )
        .unwrap();
        assert!(wire.ends_with(&bytes));
        let mut reader = Cursor::new(wire);
        let Reply::Batch {
            packets,
            encoder_started,
        } = read_json(&mut reader).unwrap()
        else {
            panic!("expected batch")
        };
        assert!(encoder_started);
        let packets = read_packets(&mut reader, packets).unwrap();
        let Packet::Video(data, actual_duration, actual_timestamp, keyframe) = &packets[0] else {
            panic!("expected video")
        };
        assert_eq!(data, &bytes);
        assert_eq!(*actual_duration, duration);
        assert_eq!(*actual_timestamp, timestamp_ns);
        assert!(*keyframe);
    }

    #[test]
    fn oversized_metadata_is_rejected_before_reading_payload() {
        for length in [0u32, MAX_MESSAGE as u32 + 1, u32::MAX] {
            let result = read_json::<Request>(&mut Cursor::new(length.to_le_bytes()));
            assert_eq!(result.err().unwrap().kind(), io::ErrorKind::InvalidData);
        }
    }

    #[test]
    fn invalid_packet_batches_are_rejected_before_allocating_payloads() {
        let oversized = PacketInfo {
            video: true,
            keyframe: false,
            length: MAX_PACKET as u32 + 1,
            duration_ns: 1,
            timestamp_ns: 0,
        };
        assert_eq!(
            read_packets(&mut io::empty(), vec![oversized])
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidData
        );
        let too_many = (0..=MAX_PACKETS)
            .map(|_| PacketInfo {
                video: true,
                keyframe: false,
                length: 1,
                duration_ns: 1,
                timestamp_ns: 0,
            })
            .collect();
        assert_eq!(
            read_packets(&mut io::empty(), too_many)
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidData
        );
        let large_batch = (0..3)
            .map(|_| PacketInfo {
                video: true,
                keyframe: false,
                length: MAX_PACKET as u32,
                duration_ns: 1,
                timestamp_ns: 0,
            })
            .collect();
        assert_eq!(
            read_packets(&mut io::empty(), large_batch)
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn truncated_video_is_not_delivered_as_a_complete_packet() {
        let metadata = vec![PacketInfo {
            video: true,
            keyframe: false,
            length: 5,
            duration_ns: 1,
            timestamp_ns: 0,
        }];
        assert_eq!(
            read_packets(&mut Cursor::new([1, 2]), metadata)
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn protocol_accepts_only_desktop_operations() {
        let mut wire = Vec::new();
        write_json(
            &mut wire,
            &serde_json::json!({ "type": "spawn", "command": "anything" }),
        )
        .unwrap();
        assert!(read_json::<Request>(&mut Cursor::new(wire)).is_err());
    }
}
