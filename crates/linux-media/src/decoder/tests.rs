use std::time::Instant;

use super::*;

#[test]
fn negotiated_codec_selects_matching_rtp_caps_parser_and_decoder() {
    for (codec, factory, encoding, depayloader, parser) in [
        (
            Codec::H264,
            "vah264dec",
            "H264",
            "rtph264depay",
            "h264parse",
        ),
        (
            Codec::H265,
            "vah265dec",
            "H265",
            "rtph265depay",
            "h265parse",
        ),
        (Codec::Av1, "vaav1dec", "AV1", "rtpav1depay", "av1parse"),
    ] {
        let pipeline = codec_description(104, codec, factory);
        assert!(pipeline.contains(&format!("encoding-name={encoding}")));
        assert!(pipeline.contains(depayloader) && pipeline.contains(parser));
        assert!(pipeline.contains("sync=false max-buffers=1 drop=false"));
        assert!(factories(codec, false).contains(&factory));
    }
}

fn red_frame_packets(timestamp: u32, sequence: &mut u16) -> Vec<Vec<u8>> {
    let encoded = include_bytes!("../../../native/examples/fixtures/red-64x64.h264");
    packetize(encoded, timestamp, sequence)
}

fn packetize(encoded: &[u8], timestamp: u32, sequence: &mut u16) -> Vec<Vec<u8>> {
    let mut nalus = Vec::new();
    let mut start = None;
    let mut i = 0;
    while i + 3 <= encoded.len() {
        let prefix = if encoded[i..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if encoded[i..].starts_with(&[0, 0, 1]) {
            3
        } else {
            i += 1;
            continue;
        };
        if let Some(start) = start {
            nalus.push(&encoded[start..i]);
        }
        i += prefix;
        start = Some(i);
    }
    nalus.push(&encoded[start.unwrap()..]);
    let count = nalus.len();
    nalus
        .into_iter()
        .enumerate()
        .map(|(index, nalu)| {
            let mut packet = vec![0x80, 96 | if index + 1 == count { 0x80 } else { 0 }];
            packet.extend_from_slice(&sequence.to_be_bytes());
            packet.extend_from_slice(&timestamp.to_be_bytes());
            packet.extend_from_slice(&1_u32.to_be_bytes());
            packet.extend_from_slice(nalu);
            *sequence = sequence.wrapping_add(1);
            packet
        })
        .collect()
}

fn assert_red(frame: &DecodedFrame) {
    assert_eq!((frame.width, frame.height), (64, 64));
    assert_eq!(frame.pixels.len(), 64 * 64 * 4);
    for pixel in frame.pixels.as_chunks::<4>().0 {
        assert!(pixel[0] > 230, "red channel: {pixel:?}");
        assert!(pixel[1] < 20 && pixel[2] < 20, "RGBA order: {pixel:?}");
        assert_eq!(pixel[3], 255);
    }
}

#[test]
#[ignore = "requires GStreamer RTP, libav H.264, and video conversion plugins"]
fn runtime_decodes_a_single_rtp_picture_without_a_following_frame_or_eos() {
    let decoder = RtpVideoDecoder::with_factory(96, "avdec_h264").unwrap();
    assert!(decoder.take_keyframe_request());
    assert!(!decoder.take_keyframe_request());
    for packet in red_frame_packets(3000, &mut 100) {
        assert!(decoder.try_push(&packet).unwrap());
    }
    let frame = decoder
        .next_frame(Duration::from_secs(2))
        .unwrap()
        .expect("one complete IDR must decode without waiting for the next frame");
    assert_red(&frame);
    decoder.stop().unwrap();
    decoder.stop().unwrap();
    assert!(matches!(decoder.try_push(&[0; 12]), Err(Error::Ended)));
    assert!(matches!(
        decoder.next_frame(Duration::ZERO),
        Err(Error::Ended)
    ));
}

#[test]
#[ignore = "requires GStreamer RTP, libav H.264, and video conversion plugins"]
fn runtime_forwards_decoder_keyframe_requests_to_the_receiver() {
    let decoder = RtpVideoDecoder::with_factory(96, "avdec_h264").unwrap();
    assert!(decoder.take_keyframe_request());
    let element = decoder.pipeline.child(c"decoder").unwrap();
    // SAFETY: The constructor returns an owned event and send_event transfers
    // ownership to the retained decoder, which routes upstream through appsrc.
    unsafe {
        let event = (element.api.force_key_unit)(ffi::CLOCK_TIME_NONE, 1, 0);
        assert!(!event.is_null());
        (element.api.element_send_event)(element.ptr.as_ptr(), event);
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    while !decoder.take_keyframe_request() {
        assert!(
            Instant::now() < deadline,
            "upstream keyframe request was lost"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(!decoder.take_keyframe_request());
}

#[test]
#[ignore = "requires GStreamer RTP, libav H.264, and video conversion plugins"]
fn runtime_packet_loss_requests_a_keyframe_and_recovers_at_the_next_idr() {
    let decoder = RtpVideoDecoder::with_factory(96, "avdec_h264").unwrap();
    decoder.take_keyframe_request();
    let mut sequence = 100;
    for packet in red_frame_packets(3000, &mut sequence) {
        assert!(decoder.try_push(&packet).unwrap());
    }
    assert_red(&decoder.next_frame(Duration::from_secs(2)).unwrap().unwrap());
    decoder.take_keyframe_request();

    // A missing packet separates two complete pictures. The depayloader must
    // forward its refresh request through our bridge and recover on this IDR.
    sequence = sequence.wrapping_add(1);
    for packet in red_frame_packets(6000, &mut sequence) {
        assert!(decoder.try_push(&packet).unwrap());
    }
    assert_red(&decoder.next_frame(Duration::from_secs(2)).unwrap().unwrap());
    assert!(
        decoder.take_keyframe_request(),
        "packet loss did not request a PLI"
    );
}

#[test]
#[ignore = "requires GStreamer H.264/HEVC RTP depayloaders"]
fn runtime_depay_recovery_keeps_parameter_sets_with_the_keyframe() {
    for (codec, bytes, parser, parameters) in [
        (
            Codec::H264,
            include_bytes!("../../../native/examples/fixtures/red-64x64.h264").as_slice(),
            "h264parse",
            &[7_u8, 8][..],
        ),
        (
            Codec::H265,
            include_bytes!("../../../native/examples/fixtures/red-64x64.h265").as_slice(),
            "h265parse",
            &[32_u8, 33, 34][..],
        ),
    ] {
        // Observe the depayloader's output before a parser or decoder can cache
        // headers and conceal their loss. The real graph's caps must group the
        // parameter NALs and the IDR/IRAP into the same complete access unit.
        let graph = codec_description(96, codec, "unused");
        let parser_boundary = format!(" ! {parser}");
        let (prefix, _) = graph.split_once(parser_boundary.as_str()).unwrap();
        let pipeline = Pipeline::new(&format!(
            "{prefix} ! appsink name=frames sync=false max-buffers=1 drop=false"
        ))
        .unwrap();
        let input = pipeline.child(c"input").unwrap();
        let probe = KeyframeProbe::new(&input).unwrap();
        let decoder = RtpVideoDecoder {
            pipeline,
            input,
            probe,
            factory: "unused",
        };
        let mut sequence = 100;
        for timestamp in [3000, 6000] {
            for packet in packetize(bytes, timestamp, &mut sequence) {
                assert!(decoder.try_push(&packet).unwrap());
            }
            let sample = decoder
                .pipeline
                .pull(Duration::from_secs(2))
                .unwrap()
                .expect("complete keyframe access unit");
            let output = sample.bytes().unwrap();
            let kinds: Vec<_> = output
                .windows(5)
                .filter(|window| window.starts_with(&[0, 0, 0, 1]))
                .map(|window| {
                    if codec == Codec::H264 {
                        window[4] & 31
                    } else {
                        (window[4] >> 1) & 63
                    }
                })
                .collect();
            for parameter in parameters {
                assert!(
                    kinds.contains(parameter),
                    "{codec:?} lost parameter NAL {parameter}: {kinds:?}"
                );
            }
            assert!(kinds.iter().any(|kind| if codec == Codec::H264 {
                *kind == 5
            } else {
                (16..=21).contains(kind)
            }));
            sequence = sequence.wrapping_add(1); // Force recovery before the next picture.
        }
        decoder.stop().unwrap();
    }
}

#[test]
#[ignore = "requires a working GStreamer VA-API or NVDEC H.264 decoder"]
fn runtime_reports_static_fixture_hardware_output_delay() {
    let decoder = RtpVideoDecoder::new(96).unwrap();
    assert_ne!(decoder.factory(), "avdec_h264");
    let mut sequence = 100;
    let mut outputs = 0;
    for timestamp in [3000, 6000, 9000] {
        for packet in red_frame_packets(timestamp, &mut sequence) {
            assert!(decoder.try_push(&packet).unwrap());
        }
        if let Some(frame) = decoder.next_frame(Duration::from_millis(100)).unwrap() {
            assert_red(&frame);
            outputs += 1;
        }
    }
    // This static all-IDR fixture has SPS max_dec_frame_buffering=1. On
    // GStreamer 1.26, vah264dec retains its last picture until another arrives,
    // even in flexible mode. Report that delay rather than using EOS to hide it.
    // The test below exercises production encoder output and requires both its
    // initial IDR and final P picture to appear without a following picture.
    println!(
        "{}: {outputs}/3 static fixture pictures available before EOS",
        decoder.factory()
    );
    assert!(
        outputs >= 2,
        "hardware decoder did not sustain fixture decoding"
    );
}

#[test]
#[ignore = "requires working GStreamer VA-API/NVENC H.264 encoding and decoding"]
fn runtime_hardware_delivers_real_encoder_idr_and_final_p_frame_without_eos() {
    use crate::{Codec, Encoder, EncoderSettings};

    let settings = EncoderSettings {
        codec: Codec::H264,
        width: 64,
        height: 64,
        fps: 60.0,
        bitrate_bps: 1_000_000,
        max_bitrate_bps: 2_000_000,
        profile: "constrained-baseline",
    };
    let red = [0, 0, 255, 255].repeat(64 * 64);
    let (mut encoder, first) = Encoder::start(&settings, &red, 0).unwrap();
    let decoder = RtpVideoDecoder::new(96).unwrap();
    let mut sequence = 100;
    for packet in packetize(&first[0].data, 3000, &mut sequence) {
        assert!(decoder.try_push(&packet).unwrap());
    }
    let frame = decoder
        .next_frame(Duration::from_secs(2))
        .unwrap()
        .expect("real encoder's first IDR remained in the hardware decoder");
    assert_red(&frame);

    let green = [0, 255, 0, 255].repeat(64 * 64);
    let mut output = encoder.encode(&green, 16_666_667).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while output.is_empty() {
        assert!(
            Instant::now() < deadline,
            "hardware encoder did not emit P frame"
        );
        output.extend(encoder.poll_output().unwrap());
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(
        !output[0].is_keyframe,
        "test must exercise a dependent picture"
    );
    for packet in packetize(&output[0].data, 4500, &mut sequence) {
        assert!(decoder.try_push(&packet).unwrap());
    }
    let frame = decoder
        .next_frame(Duration::from_secs(2))
        .unwrap()
        .expect("the final P frame must be delivered when the desktop goes idle");
    for pixel in frame.pixels.as_chunks::<4>().0 {
        assert!(pixel[1] > 230 && pixel[0] < 20 && pixel[2] < 20);
    }
}
