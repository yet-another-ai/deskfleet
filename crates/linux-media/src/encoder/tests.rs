use super::*;

fn settings(codec: Codec) -> EncoderSettings {
    EncoderSettings {
        codec,
        width: 320,
        height: 240,
        fps: 30.0,
        bitrate_bps: 1_000_000,
        max_bitrate_bps: 2_000_000,
        profile: if codec == Codec::H264 {
            "constrained-baseline"
        } else {
            "main"
        },
    }
}

#[test]
fn malformed_frame_fails_without_loading_runtime() {
    assert!(Encoder::start(&settings(Codec::H264), &[0; 12], 0).is_err());
    let mut options = settings(Codec::H264);
    options.fps = f64::NAN;
    assert!(validate(&options, &vec![0; 320 * 240 * 4]).is_err());
    options = settings(Codec::Av1);
    options.profile = "high";
    assert!(validate(&options, &vec![0; 320 * 240 * 4]).is_err());
}

#[test]
fn bitrate_properties_match_each_plugins_units() {
    for codec in Codec::ALL {
        for factory in codec.factories() {
            let (average, maximum, unit) = if factory.starts_with("nv") {
                (977, 1954, 1024)
            } else {
                (1000, 2000, 1000)
            };
            let pipeline = description(&settings(codec), factory);
            assert!(pipeline.contains(&format!(" bitrate={average} ")));
            if factory.starts_with("nv") {
                assert!(pipeline.contains(&format!(" max-bitrate={maximum} ")));
            }
            // Quantization may add at most one property unit, not 2.4%.
            let effective = bitrate_property(factory, 1_000_000) * unit;
            assert!((1_000_000..1_000_000 + unit).contains(&effective));
            assert_eq!(bitrate_property(factory, 0), 0);
        }
    }
}

#[test]
fn x264_input_drops_odd_trailing_pixels() {
    let mut odd = settings(Codec::H264);
    (odd.width, odd.height) = (321, 241);
    assert!(description(&odd, "x264enc").contains(",width=320,height=240,"));
    assert!(description(&odd, "vah264enc").contains(",width=321,height=241,"));
}

#[test]
#[ignore = "requires GStreamer and a working VA-API or NVENC hardware encoder"]
fn advertised_hardware_encodes_and_decodes_idle_keyframes() {
    let api = ffi::api().unwrap();
    let hardware = |name: &str| name != "x264enc" && api.has_factory(name);
    let codecs: Vec<_> = Codec::ALL
        .into_iter()
        .filter(|codec| crate::codec::has_encoder(*codec, hardware))
        .collect();
    assert!(
        !codecs.is_empty(),
        "hardware smoke requires at least one advertised codec"
    );
    for codec in codecs {
        let factories: Vec<_> = codec
            .factories()
            .iter()
            .copied()
            .filter(|name| hardware(name))
            .collect();
        encodes_one_frame_and_idle_keyframe(codec, &factories);
    }
}

#[test]
#[ignore = "requires GStreamer x264enc, h264parse and an H.264 decoder"]
fn x264_encodes_and_decodes_idle_keyframes() {
    encodes_one_frame_and_idle_keyframe(Codec::H264, &["x264enc"]);
}

#[test]
#[ignore = "requires GStreamer x264enc, h264parse and an H.264 decoder"]
fn x264_encodes_odd_frames_without_their_trailing_pixels() {
    let mut odd = settings(Codec::H264);
    (odd.width, odd.height) = (321, 241);
    // Rows copied with the wrong stride would shift across this vertical edge.
    let pixels: Vec<u8> = (0..321 * 241)
        .flat_map(|pixel| [if pixel % 321 < 160 { 100 } else { 130 }; 4])
        .collect();
    let (_encoder, first) = Encoder::start_with(&["x264enc"], &odd, &pixels, 0).unwrap();
    let decoded = decode_frame(Codec::H264, &first[0]);
    for y in [0, 239] {
        assert_gray_pixel(&decoded, (100, y), 100);
        assert_gray_pixel(&decoded, (300, y), 130);
    }
}

fn encodes_one_frame_and_idle_keyframe(codec: Codec, factories: &[&'static str]) {
    let pixels = vec![100; 320 * 240 * 4];
    let (mut encoder, first) = Encoder::start_with(factories, &settings(codec), &pixels, 0)
        .unwrap_or_else(|error| panic!("{codec:?}: {error}"));
    assert!(first[0].is_keyframe);
    if codec != Codec::Av1 {
        assert!(first[0].data.starts_with(&[0, 0, 0, 1]));
    }
    assert_gray_pixel(&decode_frame(codec, &first[0]), (0, 0), 100);
    encoder.request_keyframe();
    let mut packets = encoder.encode(&pixels, 1_000_000_000).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while packets.is_empty() && Instant::now() < deadline {
        packets.extend(encoder.pull(Duration::from_millis(20)).unwrap());
    }
    assert!(
        !packets.is_empty(),
        "static desktop keyframe was never encoded"
    );
    assert!(packets[0].is_keyframe);
    assert!(packets[0].timestamp_ns > first[0].timestamp_ns);
    // A fresh decoder verifies that requested keyframes include the headers
    // needed for a viewer to recover after packet loss or join an idle stream.
    assert_gray_pixel(&decode_frame(codec, &packets[0]), (0, 0), 100);
    encoder.flush().unwrap();
    println!(
        "{codec:?}: {} encoded/decoded initial and requested idle keyframes",
        encoder.factory
    );
}

// The fixtures use gray pixels so all three decoded color channels have the
// same expected value. Allow small errors from lossy encoding and color conversion;
// the odd-size fixture samples both shades at the top and bottom to catch row drift.
fn assert_gray_pixel(pixels: &[u8], (x, y): (usize, usize), expected: u8) {
    let pixel = (y * 320 + x) * 4;
    for channel in &pixels[pixel..pixel + 3] {
        assert!(channel.abs_diff(expected) <= 5, "({x}, {y}): {channel}");
    }
}

fn decode_frame(codec: Codec, packet: &EncodedFrame) -> Vec<u8> {
    let api = ffi::api().unwrap();
    let candidates: &[&str] = match codec {
        Codec::H264 => &["vah264dec", "nvh264dec", "avdec_h264"],
        Codec::H265 => &["vah265dec", "nvh265dec", "avdec_h265"],
        Codec::Av1 => &["vaav1dec", "nvav1dec", "dav1ddec", "av1dec"],
    };
    let decoder = candidates
        .iter()
        .find(|name| api.has_factory(name))
        .expect("encoder smoke also requires a matching decoder plugin");
    let pipeline = Pipeline::new(&format!(
        "appsrc name=input format=time caps={} ! \
         {} ! {decoder} ! videoconvert ! video/x-raw,format=BGRA ! \
         appsink name=frames sync=false",
        codec.output_caps(),
        codec.parser()
    ))
    .unwrap();
    let input = pipeline.child(c"input").unwrap();
    // SAFETY: This test allocates an owned buffer and initializes it before
    // transferring it to appsrc, using the same public ABI as the encoder.
    let buffer = unsafe {
        (api.buffer_new_allocate)(
            std::ptr::null_mut(),
            packet.data.len(),
            std::ptr::null_mut(),
        )
    };
    assert!(!buffer.is_null());
    // SAFETY: Fresh buffer is exclusively owned and packet data is readable.
    unsafe {
        (*buffer).pts = packet.timestamp_ns;
        (*buffer).duration = packet.duration_ns;
        assert_eq!(
            (api.buffer_fill)(buffer, 0, packet.data.as_ptr().cast(), packet.data.len()),
            packet.data.len()
        );
        assert_eq!((api.source_push_buffer)(input.ptr.as_ptr(), buffer), 0);
        assert_eq!((api.source_end_of_stream)(input.ptr.as_ptr()), 0);
    }
    let decoded = pipeline.pull(Duration::from_secs(2)).unwrap().unwrap();
    assert_eq!(decoded.dimensions().unwrap(), (320, 240));
    let pixels = decoded.bytes().unwrap();
    assert_eq!(pixels.len(), 320 * 240 * 4);
    pixels
}
