//! Bounded H.264, HEVC and AV1 RTP assembly for Windows/macOS decoders.

use bytes::Bytes;
use deskfleet_native::rtc::VideoCodec;
use rtc::rtp::codec::av1::Av1Depacketizer;
use rtc::rtp::packetizer::Depacketizer;
use std::collections::HashMap;
use std::time::{Duration, Instant};

const REORDER: Duration = Duration::from_millis(10);
const MAX_PACKETS: usize = 64;
const MAX_PICTURE: usize = 8 * 1024 * 1024;

struct Packet {
    timestamp: u32,
    marker: bool,
    payload: Vec<u8>,
}

pub(crate) struct AccessUnit {
    pub bytes: Vec<u8>,
    pub timestamp: u32,
}

pub(crate) struct Assembler {
    codec: VideoCodec,
    payload_type: u8,
    ssrc: Option<u32>,
    next: Option<u16>,
    packets: HashMap<u16, Packet>,
    gap: Option<Instant>,
    timestamp: Option<u32>,
    bytes: Vec<u8>,
    fragment: bool,
    fragment_header: u8,
    fragment_start: usize,
    idr: bool,
    waiting: bool,
    request: bool,
    sps: Vec<u8>,
    pps: Vec<u8>,
    vps: Vec<u8>,
    fragment_second: u8,
    av1: Av1Depacketizer,
    av1_fragment_bytes: usize,
}

impl Assembler {
    #[cfg(test)]
    pub fn new(payload_type: u8) -> Self {
        Self::for_codec(payload_type, VideoCodec::H264)
    }

    pub fn for_codec(payload_type: u8, codec: VideoCodec) -> Self {
        Self {
            codec,
            payload_type,
            ssrc: None,
            next: None,
            packets: HashMap::new(),
            gap: None,
            timestamp: None,
            bytes: Vec::new(),
            fragment: false,
            fragment_header: 0,
            fragment_start: 0,
            idr: false,
            waiting: true,
            request: true,
            sps: Vec::new(),
            pps: Vec::new(),
            vps: Vec::new(),
            fragment_second: 0,
            av1: Av1Depacketizer::new(),
            av1_fragment_bytes: 0,
        }
    }

    /// A full reorder window backpressures the producer until poll declares loss.
    pub fn push(&mut self, data: &[u8]) -> Result<bool, &'static str> {
        if data.len() < 12 || data[0] >> 6 != 2 || data[1] & 127 != self.payload_type {
            return Err("invalid video RTP header");
        }
        let seq = u16::from_be_bytes([data[2], data[3]]);
        let ssrc = u32::from_be_bytes(data[8..12].try_into().expect("fixed slice"));
        if self.ssrc.is_some_and(|old| old != ssrc) {
            return Err("video RTP SSRC changed");
        }
        self.ssrc = Some(ssrc);
        let next = *self.next.get_or_insert(seq);
        if seq.wrapping_sub(next) > i16::MAX as u16 || self.packets.contains_key(&seq) {
            return Ok(true); // Late/duplicate packets cannot damage a new picture.
        }
        if self.packets.len() >= MAX_PACKETS {
            return Ok(false);
        }
        let mut offset = 12 + usize::from(data[0] & 15) * 4;
        if data[0] & 16 != 0 {
            let extension = data
                .get(offset..offset + 4)
                .ok_or("truncated RTP extension")?;
            offset += 4 + usize::from(u16::from_be_bytes([extension[2], extension[3]])) * 4;
        }
        let padding = if data[0] & 32 != 0 {
            let count = usize::from(*data.last().ok_or("missing RTP padding")?);
            if count == 0 {
                return Err("invalid RTP padding");
            }
            count
        } else {
            0
        };
        let end = data
            .len()
            .checked_sub(padding)
            .ok_or("invalid RTP padding")?;
        let payload = data
            .get(offset..end)
            .filter(|bytes| !bytes.is_empty())
            .ok_or("empty RTP payload")?;
        if payload.len() > 65535 {
            return Err("oversized RTP payload");
        }
        self.packets.insert(
            seq,
            Packet {
                timestamp: u32::from_be_bytes(data[4..8].try_into().expect("fixed slice")),
                marker: data[1] & 128 != 0,
                payload: payload.to_vec(),
            },
        );
        Ok(true)
    }

    pub fn take_request(&mut self) -> bool {
        std::mem::take(&mut self.request)
    }

    fn lost(&mut self) {
        self.bytes.clear();
        self.timestamp = None;
        self.fragment = false;
        self.idr = false;
        self.waiting = true;
        self.request = true;
        self.av1 = Av1Depacketizer::new();
        self.av1_fragment_bytes = 0;
    }

    pub fn poll(&mut self, now: Instant) -> Option<AccessUnit> {
        loop {
            let next = self.next?;
            let Some(packet) = self.packets.remove(&next) else {
                if self.packets.is_empty() {
                    self.gap = None;
                    return None;
                }
                let since = *self.gap.get_or_insert(now);
                if now.duration_since(since) < REORDER && self.packets.len() < MAX_PACKETS {
                    return None;
                }
                let nearest = *self
                    .packets
                    .keys()
                    .min_by_key(|seq| seq.wrapping_sub(next))?;
                self.lost();
                self.next = Some(nearest);
                self.gap = None;
                continue;
            };
            self.next = Some(next.wrapping_add(1));
            self.gap = None;
            if self
                .timestamp
                .is_some_and(|timestamp| timestamp != packet.timestamp)
            {
                self.lost();
            }
            self.timestamp = Some(packet.timestamp);
            if self.append(&packet.payload).is_err() || self.bytes.len() > MAX_PICTURE {
                self.lost();
                continue;
            }
            if !packet.marker {
                continue;
            }
            if self.fragment {
                self.lost();
                continue;
            }
            let bytes = std::mem::take(&mut self.bytes);
            let idr = std::mem::take(&mut self.idr);
            self.timestamp = None;
            if self.waiting && !idr {
                continue;
            }
            let bytes = if self.waiting {
                if self.codec != VideoCodec::Av1
                    && (self.sps.is_empty()
                        || self.pps.is_empty()
                        || (self.codec == VideoCodec::H265 && self.vps.is_empty()))
                {
                    self.request = true;
                    continue;
                }
                self.waiting = false;
                [
                    self.vps.as_slice(),
                    self.sps.as_slice(),
                    self.pps.as_slice(),
                    bytes.as_slice(),
                ]
                .concat()
            } else {
                bytes
            };
            if !bytes.is_empty() {
                return Some(AccessUnit {
                    bytes,
                    timestamp: packet.timestamp,
                });
            }
        }
    }

    fn nal(&mut self, bytes: &[u8]) -> Result<(), ()> {
        let kind = bytes.first().ok_or(())? & 31;
        if !(1..=23).contains(&kind) || bytes[0] & 128 != 0 {
            return Err(());
        }
        self.idr |= kind == 5;
        let annex = [b"\0\0\0\x01".as_slice(), bytes].concat();
        match kind {
            7 => self.sps = annex.clone(),
            8 => self.pps = annex.clone(),
            _ => {}
        }
        self.bytes.extend_from_slice(&annex);
        Ok(())
    }

    fn append(&mut self, payload: &[u8]) -> Result<(), ()> {
        match self.codec {
            VideoCodec::H265 => return self.hevc(payload),
            VideoCodec::Av1 => return self.av1(payload),
            VideoCodec::H264 => {}
        }
        if payload[0] & 128 != 0 {
            return Err(());
        }
        match payload[0] & 31 {
            1..=23 if !self.fragment => self.nal(payload),
            24 if !self.fragment => {
                let mut offset = 1;
                while offset < payload.len() {
                    let size = payload.get(offset..offset + 2).ok_or(())?;
                    let length = usize::from(u16::from_be_bytes([size[0], size[1]]));
                    offset += 2;
                    self.nal(payload.get(offset..offset + length).ok_or(())?)?;
                    offset += length;
                }
                Ok(())
            }
            28 if payload.len() > 2 => {
                let header = payload[1];
                let start = header & 128 != 0;
                let end = header & 64 != 0;
                if header & 32 != 0 || start && end || !(1..=23).contains(&(header & 31)) {
                    return Err(());
                }
                if start {
                    if self.fragment {
                        return Err(());
                    }
                    self.fragment = true;
                    self.fragment_header = (payload[0] & 224) | (header & 31);
                    self.fragment_start = self.bytes.len();
                    self.idr |= header & 31 == 5;
                    self.bytes
                        .extend_from_slice(&[0, 0, 0, 1, (payload[0] & 224) | (header & 31)]);
                } else if !self.fragment
                    || self.fragment_header != (payload[0] & 224) | (header & 31)
                {
                    return Err(());
                }
                self.bytes.extend_from_slice(&payload[2..]);
                if end {
                    self.fragment = false;
                    match header & 31 {
                        7 => self.sps = self.bytes[self.fragment_start..].to_vec(),
                        8 => self.pps = self.bytes[self.fragment_start..].to_vec(),
                        _ => {}
                    }
                }
                Ok(())
            }
            _ => Err(()),
        }
    }

    fn hevc_nal(&mut self, nal: &[u8]) -> Result<(), ()> {
        if nal.len() < 2 || nal[0] & 128 != 0 || nal[1] & 7 == 0 {
            return Err(());
        }
        let kind = (nal[0] >> 1) & 63;
        if kind >= 48 {
            return Err(());
        }
        self.idr |= (16..=21).contains(&kind);
        let annex = [b"\0\0\0\x01".as_slice(), nal].concat();
        match kind {
            32 => self.vps = annex.clone(),
            33 => self.sps = annex.clone(),
            34 => self.pps = annex.clone(),
            _ => {}
        }
        self.bytes.extend_from_slice(&annex);
        Ok(())
    }

    // RFC 7798, without DONL (not negotiated by DeskFleet).
    fn hevc(&mut self, payload: &[u8]) -> Result<(), ()> {
        if payload.len() < 2 || payload[0] & 128 != 0 || payload[1] & 7 == 0 {
            return Err(());
        }
        match (payload[0] >> 1) & 63 {
            0..=47 if !self.fragment => self.hevc_nal(payload),
            48 if !self.fragment => {
                let mut offset = 2;
                while offset < payload.len() {
                    let length = payload.get(offset..offset + 2).ok_or(())?;
                    let length = usize::from(u16::from_be_bytes([length[0], length[1]]));
                    offset += 2;
                    self.hevc_nal(payload.get(offset..offset + length).ok_or(())?)?;
                    offset += length;
                }
                Ok(())
            }
            49 if payload.len() > 3 => {
                let kind = payload[2] & 63;
                let start = payload[2] & 128 != 0;
                let end = payload[2] & 64 != 0;
                let header = (payload[0] & 129) | (kind << 1);
                if kind >= 48 || start && end {
                    return Err(());
                }
                if start {
                    if self.fragment {
                        return Err(());
                    }
                    self.fragment = true;
                    self.fragment_header = header;
                    self.fragment_second = payload[1];
                    self.fragment_start = self.bytes.len();
                    self.bytes
                        .extend_from_slice(&[0, 0, 0, 1, header, payload[1]]);
                } else if !self.fragment
                    || self.fragment_header != header
                    || self.fragment_second != payload[1]
                {
                    return Err(());
                }
                self.bytes.extend_from_slice(&payload[3..]);
                if end {
                    self.fragment = false;
                    self.idr |= (16..=21).contains(&kind);
                    let nal = self.bytes[self.fragment_start..].to_vec();
                    match kind {
                        32 => self.vps = nal,
                        33 => self.sps = nal,
                        34 => self.pps = nal,
                        _ => {}
                    }
                }
                Ok(())
            }
            _ => Err(()),
        }
    }

    fn av1(&mut self, payload: &[u8]) -> Result<(), ()> {
        // Z must continue an existing OBU; Y keeps the last OBU fragmented.
        if payload.len() < 2 || payload[0] & 7 != 0 {
            return Err(());
        }
        let continuation = payload[0] & 128 != 0;
        let new_sequence = payload[0] & 8 != 0;
        if continuation != self.fragment || continuation && new_sequence {
            return Err(());
        }
        self.av1_fragment_bytes = self
            .av1_fragment_bytes
            .checked_add(payload.len())
            .ok_or(())?;
        if self.av1_fragment_bytes > MAX_PICTURE {
            return Err(());
        }
        let bytes = self
            .av1
            .depacketize(&Bytes::copy_from_slice(payload))
            .map_err(|_| ())?;
        self.bytes.extend_from_slice(&bytes);
        self.idr |= new_sequence;
        self.fragment = payload[0] & 64 != 0;
        if !self.fragment {
            self.av1_fragment_bytes = 0;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(seq: u16, timestamp: u32, marker: bool, payload: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0x80, 96 | if marker { 128 } else { 0 }];
        bytes.extend(seq.to_be_bytes());
        bytes.extend(timestamp.to_be_bytes());
        bytes.extend(1_u32.to_be_bytes());
        bytes.extend(payload);
        bytes
    }
    fn primed() -> Assembler {
        let mut assembler = Assembler::new(96);
        assembler
            .push(&packet(
                65534,
                0,
                true,
                &[24, 0, 2, 0x67, 1, 0, 2, 0x68, 2, 0, 2, 0x65, 3],
            ))
            .unwrap();
        assert!(assembler.poll(Instant::now()).is_some());
        assembler.take_request();
        assembler
    }
    #[test]
    fn reorder_fragment_and_wrap_sequence() {
        let mut a = primed();
        a.push(&packet(0, 90, true, &[28, 0x41, 3])).unwrap();
        assert!(a.poll(Instant::now()).is_none());
        a.push(&packet(65535, 90, false, &[28, 0x81, 2])).unwrap();
        let unit = a.poll(Instant::now()).unwrap();
        assert_eq!(unit.bytes, [0, 0, 0, 1, 1, 2, 3]);
        assert_eq!(unit.timestamp, 90);
        assert!(!a.take_request());
    }
    #[test]
    fn loss_waits_for_idr_with_cached_parameter_sets() {
        let mut a = primed();
        let now = Instant::now();
        a.push(&packet(0, 90, true, &[0x41, 3])).unwrap();
        assert!(a.poll(now).is_none());
        assert!(a.poll(now + REORDER).is_none());
        assert!(a.take_request());
        a.push(&packet(1, 180, true, &[0x65, 4])).unwrap();
        let unit = a.poll(now + REORDER).unwrap();
        assert_eq!(
            unit.bytes,
            [
                0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2, 0, 0, 0, 1, 0x65, 4
            ]
        );
    }
    #[test]
    fn malformed_fragment_requests_refresh() {
        let mut a = primed();
        a.push(&packet(65535, 90, true, &[28, 0x41, 3])).unwrap();
        assert!(a.poll(Instant::now()).is_none());
        assert!(a.take_request());
        assert!(a.push(&[0; 12]).is_err());
    }

    #[test]
    fn mismatched_fragment_type_never_emits_a_picture() {
        let mut a = primed();
        a.push(&packet(65535, 90, false, &[28, 0x81, 2])).unwrap();
        a.push(&packet(0, 90, true, &[28, 0x45, 3])).unwrap();
        assert!(a.poll(Instant::now()).is_none());
        assert!(a.take_request());
    }

    #[test]
    fn full_reorder_window_backpressures_then_recovers_after_loss() {
        let mut a = primed();
        for seq in 0..MAX_PACKETS as u16 {
            assert!(a.push(&packet(seq, 90, true, &[0x41, 3])).unwrap());
        }
        assert!(
            !a.push(&packet(MAX_PACKETS as u16, 90, true, &[0x41, 3]))
                .unwrap()
        );
        assert!(a.poll(Instant::now()).is_none());
        assert!(a.take_request());
        assert!(
            a.push(&packet(MAX_PACKETS as u16, 180, true, &[0x65, 4]))
                .unwrap()
        );
        assert!(a.poll(Instant::now()).is_some());
    }
}
