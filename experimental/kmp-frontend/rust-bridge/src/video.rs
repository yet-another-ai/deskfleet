//! RTP H.264 depacketizer + Annex-B OpenH264 software decoder producing BGRA8888 frames
//! across macOS, Linux, Windows, iOS, and Android.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use crate::rtc_peer::VideoReceiver;
use openh264::decoder::Decoder;
use openh264::formats::YUVSource;

const ANNEX_B_START: [u8; 4] = [0, 0, 0, 1];
const MAX_REORDER_PACKETS: usize = 64;
const MAX_ACCESS_UNIT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct DecodedFrame {
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    pub bgra: Arc<Vec<u8>>,
}

#[derive(Default)]
pub struct FrameSlot {
    latest: Mutex<Option<DecodedFrame>>,
}

impl FrameSlot {
    pub fn store(&self, width: u32, height: u32, bgra: Vec<u8>, seq: u64) {
        if let Ok(mut guard) = self.latest.lock() {
            *guard = Some(DecodedFrame {
                seq,
                width,
                height,
                bgra: Arc::new(bgra),
            });
        }
    }

    pub fn snapshot_after(&self, after_seq: u64) -> Option<DecodedFrame> {
        let guard = self.latest.lock().ok()?;
        let frame = guard.as_ref()?;
        (frame.seq > after_seq).then(|| frame.clone())
    }
}

struct RtpEntry {
    timestamp: u32,
    marker: bool,
    payload: Vec<u8>,
}

struct H264Depacketizer {
    expected_seq: Option<u16>,
    reorder: BTreeMap<u16, RtpEntry>,
    current_ts: Option<u32>,
    access_unit: Vec<u8>,
    in_fua: bool,
    sps: Vec<u8>,
    pps: Vec<u8>,
    needs_keyframe: bool,
}

impl H264Depacketizer {
    fn new() -> Self {
        Self {
            expected_seq: None,
            reorder: BTreeMap::new(),
            current_ts: None,
            access_unit: Vec::with_capacity(64 * 1024),
            in_fua: false,
            sps: Vec::new(),
            pps: Vec::new(),
            needs_keyframe: true,
        }
    }

    fn reset_after_loss(&mut self) {
        self.access_unit.clear();
        self.current_ts = None;
        self.in_fua = false;
        self.needs_keyframe = true;
    }

    fn push_rtp(&mut self, raw: &[u8]) -> (Vec<Vec<u8>>, bool) {
        let mut completed = Vec::new();
        let mut request_pli = false;
        let Some((seq, ts, marker, payload)) = parse_rtp_payload(raw) else {
            return (completed, false);
        };
        let next = *self.expected_seq.get_or_insert(seq);
        let delta = seq.wrapping_sub(next);
        if delta > 0x8000 {
            return (completed, false);
        }
        self.reorder.insert(
            seq,
            RtpEntry {
                timestamp: ts,
                marker,
                payload: payload.to_vec(),
            },
        );
        if self.reorder.len() > MAX_REORDER_PACKETS {
            if let Some(&first_available) = self.reorder.keys().next() {
                self.expected_seq = Some(first_available);
                self.reset_after_loss();
                request_pli = true;
            }
        }
        while let Some(expected) = self.expected_seq {
            let Some(entry) = self.reorder.remove(&expected) else {
                break;
            };
            self.expected_seq = Some(expected.wrapping_add(1));
            if let Some(prev_ts) = self.current_ts
                && prev_ts != entry.timestamp
                && !self.access_unit.is_empty()
            {
                if !self.in_fua {
                    completed.push(std::mem::take(&mut self.access_unit));
                } else {
                    self.reset_after_loss();
                    request_pli = true;
                }
            }
            self.current_ts = Some(entry.timestamp);
            if !self.append_h264_payload(&entry.payload) {
                self.reset_after_loss();
                request_pli = true;
                continue;
            }
            if entry.marker && !self.access_unit.is_empty() {
                completed.push(std::mem::take(&mut self.access_unit));
                self.current_ts = None;
                self.in_fua = false;
            }
        }
        (completed, request_pli)
    }

    fn append_nal(&mut self, nal: &[u8]) -> bool {
        let Some(&hdr) = nal.first() else {
            return false;
        };
        let nal_type = hdr & 0x1F;
        if nal_type == 7 {
            self.sps.clear();
            self.sps.extend_from_slice(nal);
        } else if nal_type == 8 {
            self.pps.clear();
            self.pps.extend_from_slice(nal);
        } else if nal_type == 5 {
            if !self.sps.is_empty() && !self.pps.is_empty() {
                self.access_unit.extend_from_slice(&ANNEX_B_START);
                self.access_unit.extend_from_slice(&self.sps);
                self.access_unit.extend_from_slice(&ANNEX_B_START);
                self.access_unit.extend_from_slice(&self.pps);
            }
            self.needs_keyframe = false;
        }
        if self.access_unit.len() + nal.len() + 4 > MAX_ACCESS_UNIT_BYTES {
            return false;
        }
        self.access_unit.extend_from_slice(&ANNEX_B_START);
        self.access_unit.extend_from_slice(nal);
        true
    }

    fn append_h264_payload(&mut self, payload: &[u8]) -> bool {
        let Some(&first) = payload.first() else {
            return false;
        };
        let packet_type = first & 0x1F;
        match packet_type {
            1..=23 => {
                self.in_fua = false;
                self.append_nal(payload)
            }
            24 => {
                // STAP-A
                self.in_fua = false;
                let mut offset = 1;
                while offset + 2 <= payload.len() {
                    let size = usize::from(u16::from_be_bytes([payload[offset], payload[offset + 1]]));
                    offset += 2;
                    let Some(nal) = payload.get(offset..offset + size) else {
                        return false;
                    };
                    if !self.append_nal(nal) {
                        return false;
                    }
                    offset += size;
                }
                offset == payload.len()
            }
            28 => {
                // FU-A
                if payload.len() < 2 {
                    return false;
                }
                let fu_header = payload[1];
                let start = (fu_header & 0x80) != 0;
                let end = (fu_header & 0x40) != 0;
                let nal_type = fu_header & 0x1F;
                let reconstructed_hdr = (first & 0xE0) | nal_type;
                let fragment = &payload[2..];
                if start {
                    if nal_type == 5 && !self.sps.is_empty() && !self.pps.is_empty() {
                        self.access_unit.extend_from_slice(&ANNEX_B_START);
                        self.access_unit.extend_from_slice(&self.sps);
                        self.access_unit.extend_from_slice(&ANNEX_B_START);
                        self.access_unit.extend_from_slice(&self.pps);
                        self.needs_keyframe = false;
                    }
                    if self.access_unit.len() + fragment.len() + 5 > MAX_ACCESS_UNIT_BYTES {
                        return false;
                    }
                    self.access_unit.extend_from_slice(&ANNEX_B_START);
                    self.access_unit.push(reconstructed_hdr);
                    self.access_unit.extend_from_slice(fragment);
                    self.in_fua = !end;
                    true
                } else {
                    if !self.in_fua {
                        return false;
                    }
                    if self.access_unit.len() + fragment.len() > MAX_ACCESS_UNIT_BYTES {
                        return false;
                    }
                    self.access_unit.extend_from_slice(fragment);
                    if end {
                        self.in_fua = false;
                    }
                    true
                }
            }
            _ => false,
        }
    }
}

fn parse_rtp_payload(data: &[u8]) -> Option<(u16, u32, bool, &[u8])> {
    if data.len() < 12 || (data[0] >> 6) != 2 {
        return None;
    }
    let marker = (data[1] & 0x80) != 0;
    let seq = u16::from_be_bytes([data[2], data[3]]);
    let ts = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
    let csrc_count = usize::from(data[0] & 0x0F);
    let mut offset = 12 + csrc_count * 4;
    if (data[0] & 0x10) != 0 {
        let ext = data.get(offset..offset + 4)?;
        let ext_words = usize::from(u16::from_be_bytes([ext[2], ext[3]]));
        offset += 4 + ext_words * 4;
    }
    let end = if (data[0] & 0x20) != 0 {
        let pad = usize::from(*data.last()?);
        if pad == 0 {
            return None;
        }
        data.len().checked_sub(pad)?
    } else {
        data.len()
    };
    let payload = data.get(offset..end)?;
    if payload.is_empty() {
        return None;
    }
    Some((seq, ts, marker, payload))
}

fn yuv_to_bgra(yuv: &impl YUVSource) -> (u32, u32, Vec<u8>) {
    let (width, height) = yuv.dimensions();
    let (y_stride, u_stride, v_stride) = yuv.strides();
    let y_plane = yuv.y();
    let u_plane = yuv.u();
    let v_plane = yuv.v();
    let mut out = vec![0_u8; width * height * 4];
    for row in 0..height {
        let y_row = row * y_stride;
        let uv_row_u = (row / 2) * u_stride;
        let uv_row_v = (row / 2) * v_stride;
        let out_row = row * width * 4;
        for col in 0..width {
            let y = i32::from(y_plane[y_row + col]);
            let u = i32::from(u_plane[uv_row_u + col / 2]) - 128;
            let v = i32::from(v_plane[uv_row_v + col / 2]) - 128;
            let c = (y - 16).max(0);
            let r = ((298 * c + 409 * v + 128) >> 8).clamp(0, 255) as u8;
            let g = ((298 * c - 100 * u - 208 * v + 128) >> 8).clamp(0, 255) as u8;
            let b = ((298 * c + 516 * u + 128) >> 8).clamp(0, 255) as u8;
            let idx = out_row + col * 4;
            out[idx] = b;
            out[idx + 1] = g;
            out[idx + 2] = r;
            out[idx + 3] = 255;
        }
    }
    (width as u32, height as u32, out)
}

pub fn spawn_video_worker(mut receiver: VideoReceiver, slot: Arc<FrameSlot>, rt: tokio::runtime::Handle) {
    rt.spawn(async move {
        let Ok(mut decoder) = Decoder::new() else {
            return;
        };
        let mut depacketizer = H264Depacketizer::new();
        let mut frame_seq: u64 = 0;
        let mut requested_initial = false;
        while let Ok(Some(packet)) = receiver.next_packet().await {
            if !requested_initial {
                requested_initial = true;
                let _ = receiver.request_keyframe().await;
            }
            let (units, need_pli) = depacketizer.push_rtp(&packet.data);
            if need_pli || depacketizer.needs_keyframe {
                let _ = receiver.request_keyframe().await;
            }
            for unit in units {
                match decoder.decode(&unit) {
                    Ok(Some(yuv)) => {
                        let (w, h, bgra) = yuv_to_bgra(&yuv);
                        frame_seq = frame_seq.wrapping_add(1);
                        slot.store(w, h, bgra, frame_seq);
                    }
                    Ok(None) => {}
                    Err(_) => {
                        let _ = receiver.request_keyframe().await;
                    }
                }
            }
        }
    });
}
