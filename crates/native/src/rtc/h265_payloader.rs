//! H.265/HEVC RTP payloader (RFC 7798).
//!
//! The upstream H.265 payloader does not split mixed three- and four-byte
//! Annex B start codes. This payloader preserves that encoder input contract and
//! splits Annex-B encoded H.265 NALUs into single-NALU packets or
//! Fragmentation Unit (FU) packets according to RFC 7798.

use bytes::{BufMut, Bytes, BytesMut};
use rtc::rtp::packetizer::Payloader;

/// Minimum size of an H.265 NAL unit header (2 bytes).
const NALU_HEADER_SIZE: usize = 2;

/// NAL unit type for Fragmentation Units (RFC 7798 §4.4.3).
const FU_NAL_TYPE: u8 = 49;

/// FU overhead: 2-byte `PayloadHdr` + 1-byte FU header.
const FU_OVERHEAD: usize = 3;

/// H.265/HEVC RTP payloader.
///
/// Accepts either Annex-B byte streams (start-code delimited NALUs) or
/// raw NALUs and produces RTP payloads suitable for
/// `rtp::packetizer::new_packetizer`.
#[derive(Debug, Default, Clone)]
pub struct H265Payloader;

impl Payloader for H265Payloader {
    fn payload(&mut self, mtu: usize, payload: &Bytes) -> Result<Vec<Bytes>, webrtc::error::Error> {
        if payload.is_empty() || mtu == 0 {
            return Ok(vec![]);
        }

        let mut payloads = Vec::new();
        let nalus = split_nalus(payload);

        for nalu in &nalus {
            emit_nalu(nalu, mtu, &mut payloads);
        }

        Ok(payloads)
    }

    fn clone_to(&self) -> Box<dyn Payloader> {
        Box::new(self.clone())
    }
}

// ── Annex-B NALU splitting ───────────────────────────────────────────

/// Find the next Annex-B start code (`00 00 01` or `00 00 00 01`) at or
/// after `start`.  Returns `(prefix_offset, data_offset)` where
/// `prefix_offset` is where the `00 00 …` begins and `data_offset` is the
/// first byte after the start code.
fn find_start_code(data: &[u8], start: usize) -> Option<(usize, usize)> {
    let mut i = start;
    while i + 2 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 {
            if data[i + 2] == 1 {
                return Some((i, i + 3));
            }
            if i + 3 < data.len() && data[i + 2] == 0 && data[i + 3] == 1 {
                return Some((i, i + 4));
            }
        }
        i += 1;
    }
    None
}

/// Split an Annex-B byte stream into individual NALUs.
///
/// If no start codes are found the entire payload is treated as a single
/// raw NALU (matching the behaviour of the H.264 payloader).
fn split_nalus(data: &[u8]) -> Vec<&[u8]> {
    let mut nalus = Vec::new();

    // Find the first start code.
    let Some((_prefix0, data0)) = find_start_code(data, 0) else {
        // No start codes — treat entire buffer as a single raw NALU.
        return vec![data];
    };

    let mut cur_start = data0;

    while let Some((prefix, next_data)) = find_start_code(data, cur_start) {
        // The current NALU runs from `cur_start` up to the start
        // of the next start-code prefix.
        if prefix > cur_start {
            nalus.push(&data[cur_start..prefix]);
        }
        cur_start = next_data;
    }
    // Last NALU — runs to end of buffer.
    if cur_start < data.len() {
        nalus.push(&data[cur_start..]);
    }

    nalus
}

// ── NALU → RTP payload ──────────────────────────────────────────────

/// Emit a single NALU as one or more RTP payloads.
fn emit_nalu(nalu: &[u8], mtu: usize, payloads: &mut Vec<Bytes>) {
    if nalu.len() < NALU_HEADER_SIZE {
        return;
    }

    // Single NALU packet — fits in one RTP payload.
    if nalu.len() <= mtu {
        payloads.push(Bytes::copy_from_slice(nalu));
        return;
    }

    // ── Fragmentation Unit (FU) ──────────────────────────────────────

    let hdr0 = nalu[0];
    let hdr1 = nalu[1];

    // Extract original NAL type from bits [6:1] of the first header byte.
    //
    //  +---------------+
    //  |0|1|2|3|4|5|6|7|
    //  +-+-+-+-+-+-+-+-+
    //  |F|   Type    |X|   (X = LayerID MSB)
    //  +-------------+-+
    let nal_type = (hdr0 >> 1) & 0x3F;

    // Build the 2-byte PayloadHdr with Type = 49 (FU), preserving the
    // F bit, LayerID, and TID from the original NALU header.
    let fu_payload_hdr0 = (hdr0 & 0x81) | (FU_NAL_TYPE << 1);
    let fu_payload_hdr1 = hdr1;

    let max_frag = mtu.saturating_sub(FU_OVERHEAD);
    if max_frag == 0 {
        return;
    }

    let body = &nalu[NALU_HEADER_SIZE..];
    let body_len = body.len();
    let mut offset = 0;

    while offset < body_len {
        let chunk = std::cmp::min(max_frag, body_len - offset);
        let is_start = offset == 0;
        let is_end = offset + chunk == body_len;

        // FU header byte: S | E | FuType(6)
        let mut fu_header = nal_type;
        if is_start {
            fu_header |= 0x80;
        }
        if is_end {
            fu_header |= 0x40;
        }

        let mut pkt = BytesMut::with_capacity(FU_OVERHEAD + chunk);
        pkt.put_u8(fu_payload_hdr0);
        pkt.put_u8(fu_payload_hdr1);
        pkt.put_u8(fu_header);
        pkt.extend_from_slice(&body[offset..offset + chunk]);
        payloads.push(pkt.freeze());

        offset += chunk;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annex_b_split() {
        // Two NALUs with 4-byte start codes.
        let data = [
            0x00, 0x00, 0x00, 0x01, 0x40, 0x01, // VPS (type 32)
            0x00, 0x00, 0x00, 0x01, 0x42, 0x01, 0xAA, // SPS (type 33)
        ];
        let nalus = split_nalus(&data);
        assert_eq!(nalus.len(), 2);
        assert_eq!(nalus[0], &[0x40, 0x01]);
        assert_eq!(nalus[1], &[0x42, 0x01, 0xAA]);
    }

    #[test]
    fn annex_b_three_byte_start_code() {
        let data = [
            0x00, 0x00, 0x01, 0x40, 0x01, // VPS with 3-byte start code
            0x00, 0x00, 0x01, 0x42, 0x01, 0xBB, // SPS with 3-byte start code
        ];
        let nalus = split_nalus(&data);
        assert_eq!(nalus.len(), 2);
        assert_eq!(nalus[0], &[0x40, 0x01]);
        assert_eq!(nalus[1], &[0x42, 0x01, 0xBB]);
    }

    #[test]
    fn mixed_annex_b_start_codes_produce_separate_nalus() {
        let data = Bytes::from_static(&[
            0, 0, 0, 1, 0x40, 1, 0xaa, 0, 0, 1, 0x42, 1, 0xbb, 0, 0, 0, 1, 0x26, 1, 0xcc,
        ]);
        let payloads = H265Payloader.payload(1200, &data).unwrap();
        assert_eq!(
            payloads,
            [
                Bytes::from_static(&[0x40, 1, 0xaa]),
                Bytes::from_static(&[0x42, 1, 0xbb]),
                Bytes::from_static(&[0x26, 1, 0xcc]),
            ]
        );
    }

    #[test]
    fn raw_nalu_no_start_code() {
        let data = [0x40, 0x01, 0xAA, 0xBB];
        let nalus = split_nalus(&data);
        assert_eq!(nalus.len(), 1);
        assert_eq!(nalus[0], &data[..]);
    }

    #[test]
    fn single_nalu_packet() {
        // Raw NALU without start code, fits in MTU.
        let nalu = Bytes::from_static(&[0x40, 0x01, 0xAA, 0xBB]);
        let mut p = H265Payloader;
        let payloads = p.payload(1400, &nalu).unwrap();
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0], nalu);
    }

    #[test]
    fn single_nalu_with_start_code() {
        // Annex-B format, single NALU.
        let data = Bytes::from_static(&[0x00, 0x00, 0x00, 0x01, 0x40, 0x01, 0xAA, 0xBB]);
        let mut p = H265Payloader;
        let payloads = p.payload(1400, &data).unwrap();
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].as_ref(), &[0x40, 0x01, 0xAA, 0xBB]);
    }

    #[test]
    fn fu_fragmentation() {
        // Create a NALU larger than the MTU.
        let mut data = vec![0x26, 0x01]; // type = 19 (IDR_W_RADL)
        data.extend(vec![0xCC; 100]);
        let nalu = Bytes::from(data);

        let mut p = H265Payloader;
        let payloads = p.payload(50, &nalu).unwrap();

        // Should be fragmented into multiple FU packets.
        assert!(payloads.len() > 1, "expected fragmentation");

        // First packet should have S bit set.
        assert_eq!(payloads[0][2] & 0x80, 0x80, "first FU missing S bit");
        // Last packet should have E bit set.
        let last = payloads.last().unwrap();
        assert_eq!(last[2] & 0x40, 0x40, "last FU missing E bit");

        // All FU packets should have Type=49 in PayloadHdr.
        for pkt in &payloads {
            assert!(pkt.len() <= 50);
            let pkt_type = (pkt[0] >> 1) & 0x3F;
            assert_eq!(pkt_type, 49, "FU PayloadHdr should have Type=49");
        }

        // FU type should be the original NAL type (19).
        assert_eq!(
            payloads[0][2] & 0x3F,
            19,
            "FU type should be original NAL type"
        );

        let reassembled: Vec<u8> = payloads
            .iter()
            .flat_map(|packet| packet[3..].iter().copied())
            .collect();
        assert_eq!(reassembled, nalu[2..]);
    }

    #[test]
    fn fragmentation_preserves_layer_and_temporal_identifiers() {
        let nalu = Bytes::from_static(&[0xa7, 0x9b, 1, 2, 3, 4, 5, 6]);
        let payloads = H265Payloader.payload(5, &nalu).unwrap();
        assert_eq!(payloads.len(), 3);
        for payload in payloads {
            assert_eq!(payload[0] & 0x81, nalu[0] & 0x81);
            assert_eq!(payload[1], nalu[1]);
        }
    }

    #[test]
    fn truncated_headers_and_tiny_mtu_produce_no_fragments() {
        assert!(
            H265Payloader
                .payload(100, &Bytes::from_static(&[0x26]))
                .unwrap()
                .is_empty()
        );
        assert!(
            H265Payloader
                .payload(3, &Bytes::from_static(&[0x26, 1, 2, 3]))
                .unwrap()
                .is_empty()
        );
    }
}
