use super::*;
use std::time::{Duration, Instant};

#[test]
fn never_encodes_another_negotiated_codec_as_h264() {
    for codec in [Codec::H265, Codec::AV1] {
        assert!(matches!(
            SoftwareEncoder::new(&EncoderConfig {
                codec,
                ..EncoderConfig::default()
            }),
            Err(EncoderError::Unsupported(_))
        ));
    }
}

#[test]
#[ignore = "requires optional GStreamer x264enc and h264parse"]
fn software_profiles_emit_idle_keyframes_and_accept_bitrate_updates() {
    assert!(available(), "x264 pipeline was not discovered");
    for h264_profile in [
        H264Profile::ConstrainedBaseline,
        H264Profile::Main,
        H264Profile::High,
    ] {
        let mut encoder = SoftwareEncoder::new(&EncoderConfig {
            width: 321,
            height: 241,
            fps: 30.0,
            bitrate_bps: 1_000_000,
            max_bitrate_bps: 2_000_000,
            h264_profile,
            ..EncoderConfig::default()
        })
        .unwrap();
        let pixels = vec![100; 321 * 241 * 4];
        for index in 0..2 {
            if index > 0 {
                encoder.set_bitrate(300_000, 600_000).unwrap();
            }
            encoder.request_keyframe();
            let timestamp_ns = 100_000_000 + index * 33_333_333;
            let mut packets = encoder.encode_pixels(&pixels, timestamp_ns).unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while packets.is_empty() {
                assert!(Instant::now() < deadline, "x264 buffered an idle frame");
                std::thread::sleep(Duration::from_millis(5));
                packets.extend(encoder.poll_output().unwrap());
            }
            assert_eq!(packets.len(), 1);
            assert!(packets[0].is_keyframe);
            assert_eq!(packets[0].timestamp_ns, timestamp_ns);
            assert!(packets[0].duration_ns > 0);
            assert!(packets[0].data.starts_with(&[0, 0, 0, 1]));
        }
        assert!(encoder.flush().unwrap().is_empty());
    }
}
