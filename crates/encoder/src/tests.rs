use super::*;

#[cfg(target_os = "windows")]
#[test]
#[ignore = "requires an interactive Windows desktop and an available video encoder"]
fn windows_platform_encodes_static_frame_and_requested_keyframe() {
    use std::time::{Duration, Instant};

    let display = deskfleet_capture::displays()
        .unwrap()
        .into_iter()
        .next()
        .expect("a display");
    let codecs = supported_codecs(display.id).unwrap();
    assert!(!codecs.is_empty(), "display advertised no codecs");
    let capture = deskfleet_capture::create_capture_stream(
        &display,
        &deskfleet_capture::CaptureConfig {
            fps: 30.0,
            ..Default::default()
        },
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut frame = loop {
        if let Some(frame) = capture.poll_frame().unwrap() {
            break frame;
        }
        assert!(Instant::now() < deadline, "capture produced no frame");
    };
    for codec in codecs {
        let config = EncoderConfig {
            width: frame.width,
            height: frame.height,
            fps: 30.0,
            codec,
            h264_profile: H264Profile::ConstrainedBaseline,
            ..Default::default()
        };
        let mut encoder = Encoder::new(&config).unwrap();
        for index in 0..2 {
            frame.timestamp_ns = 100_000_000 + index * 33_333_300;
            if index > 0 {
                encoder.request_keyframe();
            }
            // Submit once: asynchronous output must arrive even on a static desktop.
            let mut packets = encoder.encode(&frame).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while packets.is_empty() {
                assert!(
                    Instant::now() < deadline,
                    "platform {codec} encoder produced no output"
                );
                std::thread::sleep(Duration::from_millis(5));
                packets.extend(encoder.poll_output().unwrap());
            }
            assert_eq!(packets.len(), 1);
            let packet = &packets[0];
            assert!(
                packet.is_keyframe,
                "startup and requested {codec} frames must be keyframes"
            );
            assert_eq!(packet.timestamp_ns, frame.timestamp_ns);
            if matches!(codec, Codec::H264 | Codec::H265) {
                assert!(
                    packet.data.starts_with(&[0, 0, 0, 1]) || packet.data.starts_with(&[0, 0, 1])
                );
            } else {
                assert!(!packet.data.is_empty());
            }
            assert!(packet.duration_ns > 0);
            eprintln!(
                "platform {codec} {}x{}: {} bytes, keyframe={}, timestamp={}",
                frame.width,
                frame.height,
                packet.data.len(),
                packet.is_keyframe,
                packet.timestamp_ns
            );
        }
        encoder.flush().unwrap();
        drop(encoder);
    }
    capture.stop().unwrap();
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "requires an interactive Windows desktop on an NVIDIA GPU supporting H.264, HEVC and AV1"]
fn windows_nvenc_emits_each_frame_without_lookahead() {
    use std::time::{Duration, Instant};

    let display = deskfleet_capture::displays()
        .unwrap()
        .into_iter()
        .next()
        .expect("a display");
    let capture = deskfleet_capture::create_capture_stream(
        &display,
        &deskfleet_capture::CaptureConfig {
            fps: 60.0,
            ..Default::default()
        },
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut frame = loop {
        if let Some(frame) = capture.poll_frame().unwrap() {
            break frame;
        }
        assert!(Instant::now() < deadline, "capture produced no frame");
    };

    for (codec, h264_profile) in [
        (Codec::H264, H264Profile::ConstrainedBaseline),
        (Codec::H264, H264Profile::Main),
        (Codec::H264, H264Profile::High),
        (Codec::H265, H264Profile::High),
        (Codec::AV1, H264Profile::High),
    ] {
        let config = EncoderConfig {
            width: frame.width,
            height: frame.height,
            codec,
            h264_profile,
            h265_profile: H265Profile::Main,
            ..Default::default()
        };
        // Use NVENC directly: an H.264 fallback must not hide a failed preset.
        let mut encoder = windows::WindowsEncoder::new(&config).unwrap();
        for index in 0..6 {
            frame.timestamp_ns = 100_000_000 + index * 16_666_667;
            if index == 3 {
                encoder.request_keyframe();
            }
            // Reuse a retained texture, as the idle-desktop keyframe path does.
            // Every submission must complete without needing a future frame.
            let packets = encoder.encode(&frame).unwrap();
            assert_eq!(packets.len(), 1, "{codec:?} {h264_profile:?}");
            let packet = &packets[0];
            assert!(!packet.data.is_empty());
            assert_eq!(packet.timestamp_ns, frame.timestamp_ns);
            assert_eq!(packet.is_keyframe, index == 0 || index == 3);
            assert!(packet.duration_ns > 0);
        }
        encoder.flush().unwrap();
        eprintln!(
            "NVENC {codec:?} {h264_profile:?}: six immediate frames, including requested IDR"
        );
    }
    capture.stop().unwrap();
}

#[test]
fn rejects_invalid_configuration_before_hardware_initialization() {
    for fps in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        let config = EncoderConfig {
            fps,
            ..EncoderConfig::default()
        };
        assert!(matches!(
            Encoder::new(&config),
            Err(EncoderError::InvalidConfig(_))
        ));
    }
    for (width, height) in [(0, 1), (1, 0), (u32::MAX, 1)] {
        let config = EncoderConfig {
            width,
            height,
            ..EncoderConfig::default()
        };
        assert!(matches!(
            Encoder::new(&config),
            Err(EncoderError::InvalidConfig(_))
        ));
    }
}

#[test]
fn converts_complete_nalus_and_rejects_truncation() {
    let mut output = Vec::new();
    assert_eq!(
        bitstream::convert_avcc_to_annex_b(&[0, 2, 0x67, 1, 0, 1, 0x68], 2, &mut output),
        Some(())
    );
    assert_eq!(output, [0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68]);
    for data in [&[0, 2, 0x67][..], &[0][..], &[0, 0][..]] {
        assert_eq!(
            bitstream::convert_avcc_to_annex_b(data, 2, &mut Vec::new()),
            None
        );
    }
}

#[test]
fn nanosecond_timestamps_do_not_overflow_during_rescaling() {
    let timestamp = 86_400_000_000_000;
    assert_eq!(
        bitstream::time_to_nanoseconds(timestamp, 1_000_000_000),
        timestamp as u64
    );
    assert_eq!(bitstream::time_to_nanoseconds(9000, 90000), 100_000_000);
    assert_eq!(bitstream::time_to_nanoseconds(-1, 1), 0);
    assert_eq!(bitstream::time_to_nanoseconds(1, 0), 0);
}

#[test]
fn opus_buffers_partial_frames_and_flushes_once() {
    for channels in [1, 2] {
        let config = OpusEncoderConfig {
            channels,
            ..OpusEncoderConfig::default()
        };
        let mut encoder = OpusEncoder::new(&config).unwrap();
        let frame_samples = 960 * usize::from(channels);
        assert!(
            encoder
                .encode(&vec![0.0; frame_samples / 2])
                .unwrap()
                .is_empty()
        );
        let packets = encoder.encode(&vec![0.0; frame_samples * 2]).unwrap();
        assert_eq!(packets.len(), 2);
        let trailing = encoder.flush().unwrap();
        assert_eq!(trailing.len(), 1);
        assert!(encoder.flush().unwrap().is_empty());
        let channels = if channels == 1 {
            opus::Channels::Mono
        } else {
            opus::Channels::Stereo
        };
        let mut decoder = opus::Decoder::new(48_000, channels).unwrap();
        for packet in packets.into_iter().chain(trailing) {
            assert_eq!(packet.duration_ns, 20_000_000);
            let mut pcm = vec![0.0; frame_samples];
            assert_eq!(
                decoder.decode_float(&packet.data, &mut pcm, false).unwrap(),
                960
            );
            assert!(pcm.iter().all(|sample| sample.is_finite()));
        }
    }
}

#[test]
fn opus_rejects_unsupported_audio_configuration() {
    for (sample_rate, channels) in [(44_100, 2), (48_000, 0), (48_000, 3)] {
        assert!(
            OpusEncoder::new(&OpusEncoderConfig {
                sample_rate,
                channels,
                ..OpusEncoderConfig::default()
            })
            .is_err()
        );
    }
}
