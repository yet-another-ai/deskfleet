use crate::rtp_video::Assembler;
use bytes::Bytes;
use deskfleet_native::rtc::VideoCodec;
use rtc::rtp::{codec::av1::Av1Payloader, packetizer::Payloader};
use std::time::{Duration, Instant};

fn packet(sequence: u16, timestamp: u32, marker: bool, payload: &[u8]) -> Vec<u8> {
    let mut data = vec![0x80, 96 | if marker { 128 } else { 0 }];
    data.extend(sequence.to_be_bytes());
    data.extend(timestamp.to_be_bytes());
    data.extend(1_u32.to_be_bytes());
    data.extend(payload);
    data
}

#[test]
fn hevc_reassembles_aggregation_fragmentation_reordering_and_loss() {
    let mut a = Assembler::for_codec(96, VideoCodec::H265);
    let parameters = [96, 1, 0, 3, 64, 1, 10, 0, 3, 66, 1, 11, 0, 3, 68, 1, 12];
    a.push(&packet(65534, 90, false, &parameters)).unwrap();
    assert!(a.poll(Instant::now()).is_none());
    a.push(&packet(0, 90, true, &[98, 1, 0x40 | 19, 14]))
        .unwrap();
    assert!(a.poll(Instant::now()).is_none());
    a.push(&packet(65535, 90, false, &[98, 1, 0x80 | 19, 13]))
        .unwrap();
    let unit = a.poll(Instant::now()).unwrap();
    assert!(unit.bytes.ends_with(&[0, 0, 0, 1, 38, 1, 13, 14]));
    a.take_request();
    // Lose one FU packet, then receive an inter-picture. It must be discarded.
    a.push(&packet(1, 180, false, &[98, 1, 0x80 | 1, 1]))
        .unwrap();
    a.poll(Instant::now());
    a.push(&packet(3, 180, true, &[98, 1, 0x40 | 1, 3]))
        .unwrap();
    let now = Instant::now();
    assert!(a.poll(now).is_none());
    assert!(a.poll(now + Duration::from_millis(11)).is_none());
    assert!(a.take_request());
    a.push(&packet(4, 270, true, &[2, 1, 5])).unwrap();
    assert!(a.poll(Instant::now()).is_none());
    a.push(&packet(5, 360, true, &[38, 1, 6])).unwrap();
    let recovered = a.poll(Instant::now()).unwrap();
    assert!(recovered.bytes.starts_with(&[0, 0, 0, 1, 64, 1]));
}

#[test]
fn av1_fragmented_fixture_survives_reordering_and_requests_refresh_after_loss() {
    let fixture = Bytes::from_static(include_bytes!(
        "../../native/examples/fixtures/red-64x64.av1"
    ));
    let payloads = Av1Payloader::default().payload(8, &fixture).unwrap();
    assert!(payloads.len() > 3);
    let mut a = Assembler::for_codec(96, VideoCodec::Av1);
    let mut unit = None;
    for index in std::iter::once(0).chain((1..payloads.len()).rev()) {
        a.push(&packet(
            index as u16,
            90,
            index + 1 == payloads.len(),
            &payloads[index],
        ))
        .unwrap();
        unit = a.poll(Instant::now()).or(unit);
    }
    let unit = unit.expect("complete AV1 temporal unit");
    let config = crate::av1_config::sequence(&unit.bytes).unwrap().unwrap();
    assert_eq!((config.width, config.height), (64, 64));
    a.take_request();
    // A continuation without its first fragment cannot produce a picture.
    a.push(&packet(payloads.len() as u16, 180, true, &[0x90, 1, 2]))
        .unwrap();
    assert!(a.poll(Instant::now()).is_none());
    assert!(a.take_request());
}
