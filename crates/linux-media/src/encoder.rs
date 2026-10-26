#![allow(unsafe_code)]

use std::time::{Duration, Instant};

use crate::ffi;
use crate::pipeline::{Object, Pipeline, set_property};
use crate::{Codec, Error, Result};

const MAX_IN_FLIGHT: usize = 4;

#[derive(Clone, Debug)]
pub struct EncoderSettings {
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub bitrate_bps: u32,
    pub max_bitrate_bps: u32,
    pub profile: &'static str,
}

#[derive(Debug)]
pub struct EncodedFrame {
    pub data: Vec<u8>,
    pub timestamp_ns: u64,
    pub duration_ns: u64,
    pub is_keyframe: bool,
}

/// Hardware video encoder, owned and polled on the native capture worker.
pub struct Encoder {
    pipeline: Pipeline,
    input: Object,
    hardware: Object,
    factory: &'static str,
    settings: EncoderSettings,
    in_flight: usize,
    force_keyframe: bool,
    draining: bool,
}

impl Encoder {
    /// Verify a hardware candidate with the real first frame before accepting it.
    /// If one candidate fails, another hardware implementation of this codec is tried.
    pub fn start(
        settings: &EncoderSettings,
        pixels: &[u8],
        timestamp_ns: u64,
    ) -> Result<(Self, Vec<EncodedFrame>)> {
        validate(settings, pixels)?;
        let api = ffi::api()?;
        let mut errors = Vec::new();
        for &factory in settings
            .codec
            .factories()
            .iter()
            .filter(|name| api.has_factory(name))
        {
            let attempt = (|| {
                let pipeline = Pipeline::new(&description(settings, factory))?;
                let input = pipeline.child(c"input")?;
                let hardware = pipeline.child(c"hardware")?;
                let mut encoder = Self {
                    pipeline,
                    input,
                    hardware,
                    factory,
                    settings: settings.clone(),
                    in_flight: 0,
                    force_keyframe: false,
                    draining: false,
                };
                let mut packets = encoder.encode(pixels, timestamp_ns)?;
                let deadline = Instant::now() + Duration::from_secs(1);
                while packets.is_empty() && Instant::now() < deadline {
                    packets.extend(encoder.pull(Duration::from_millis(20))?);
                }
                if packets.is_empty() {
                    return Err(Error::Pipeline(
                        "hardware encoder produced no first packet".into(),
                    ));
                }
                Ok((encoder, packets))
            })();
            match attempt {
                Ok(value) => {
                    tracing::info!(factory, codec = ?settings.codec, "Linux hardware encoder started");
                    return Ok(value);
                }
                Err(error) => errors.push(format!("{factory}: {error}")),
            }
        }
        if errors.is_empty() {
            Err(Error::Unavailable(format!(
                "no VA-API or NVENC {:?} encoder is installed",
                settings.codec
            )))
        } else {
            Err(Error::Pipeline(errors.join("; ")))
        }
    }

    pub fn encode(&mut self, pixels: &[u8], timestamp_ns: u64) -> Result<Vec<EncodedFrame>> {
        validate(&self.settings, pixels)?;
        let packets = self.poll_output()?;
        if self.draining {
            return Err(Error::Ended);
        }
        // Drop the new input under pressure; the caller retains its newest owned
        // desktop frame. Never accumulate unbounded raw frames inside appsrc.
        if self.in_flight >= MAX_IN_FLIGHT {
            return Ok(packets);
        }
        let api = self.input.api;
        if self.force_keyframe {
            // SAFETY: The constructor transfers a valid upstream event. Sending
            // transfers its ownership even when the element rejects the event.
            let event = unsafe { (api.force_key_unit)(ffi::CLOCK_TIME_NONE, 1, 0) };
            if event.is_null() {
                return Err(Error::Pipeline("cannot allocate keyframe request".into()));
            }
            // SAFETY: hardware is a live encoder element; event is owned above.
            if unsafe { (api.element_send_event)(self.hardware.ptr.as_ptr(), event) } == 0 {
                return Err(Error::Pipeline(
                    "hardware encoder rejected keyframe request".into(),
                ));
            }
            self.force_keyframe = false;
        }
        // SAFETY: Null allocator/params select GStreamer's default allocator.
        let buffer = unsafe {
            (api.buffer_new_allocate)(std::ptr::null_mut(), pixels.len(), std::ptr::null_mut())
        };
        if buffer.is_null() {
            return Err(Error::Pipeline("cannot allocate encoder input".into()));
        }
        // SAFETY: We exclusively own the fresh buffer; pixels is readable for
        // its full length. Public timestamp fields use GStreamer's stable ABI.
        let copied = unsafe {
            (*buffer).pts = timestamp_ns;
            (*buffer).dts = timestamp_ns;
            (*buffer).duration = self.frame_duration();
            (api.buffer_fill)(buffer, 0, pixels.as_ptr().cast(), pixels.len())
        };
        if copied != pixels.len() {
            // SAFETY: The buffer has not been transferred to appsrc yet.
            unsafe { (api.mini_unref)(buffer.cast()) };
            return Err(Error::Pipeline("cannot fill encoder input".into()));
        }
        // SAFETY: input is appsrc and takes buffer ownership for every return code.
        let flow = unsafe { (api.source_push_buffer)(self.input.ptr.as_ptr(), buffer) };
        if flow < 0 {
            self.pipeline.check_error()?;
            return Err(Error::Pipeline(format!(
                "encoder input flow failed ({flow})"
            )));
        }
        self.in_flight += 1;
        Ok(packets)
    }

    fn frame_duration(&self) -> u64 {
        Duration::from_secs_f64(1.0 / self.settings.fps).as_nanos() as u64
    }

    fn pull(&mut self, timeout: Duration) -> Result<Option<EncodedFrame>> {
        let Some(sample) = self.pipeline.pull(timeout)? else {
            return Ok(None);
        };
        let (timestamp_ns, duration_ns, is_keyframe) = sample.timing()?;
        if timestamp_ns == ffi::CLOCK_TIME_NONE {
            return Err(Error::Pipeline("encoded frame has no timestamp".into()));
        }
        let data = sample.bytes()?;
        if data.is_empty() {
            return Ok(None);
        }
        self.in_flight = self.in_flight.saturating_sub(1);
        Ok(Some(EncodedFrame {
            data,
            timestamp_ns,
            is_keyframe,
            duration_ns: if duration_ns == ffi::CLOCK_TIME_NONE {
                self.frame_duration()
            } else {
                duration_ns
            },
        }))
    }

    pub fn poll_output(&mut self) -> Result<Vec<EncodedFrame>> {
        let mut packets = Vec::new();
        while let Some(packet) = self.pull(Duration::ZERO)? {
            packets.push(packet);
        }
        Ok(packets)
    }

    pub fn request_keyframe(&mut self) {
        self.force_keyframe = true;
    }

    pub fn set_bitrate(&self, average: u32, maximum: u32) -> Result<()> {
        if average == 0 || (maximum != 0 && maximum < average) {
            return Err(Error::Pipeline("invalid encoder bitrate".into()));
        }
        set_property(
            &self.hardware,
            c"bitrate",
            &average.div_ceil(1000).to_string(),
        )?;
        if self.factory.starts_with("nv") {
            set_property(
                &self.hardware,
                c"max-bitrate",
                &maximum.div_ceil(1000).to_string(),
            )?;
        }
        self.pipeline.check_error()
    }

    pub fn flush(&mut self) -> Result<Vec<EncodedFrame>> {
        if !self.draining {
            // SAFETY: input is a retained appsrc; EOS is sent only once.
            if unsafe { (self.input.api.source_end_of_stream)(self.input.ptr.as_ptr()) } < 0 {
                return Err(Error::Pipeline("cannot finish encoder input".into()));
            }
            self.draining = true;
        }
        let mut packets = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            match self.pull(Duration::from_millis(20)) {
                Ok(Some(packet)) => packets.push(packet),
                Err(Error::Ended) => return Ok(packets),
                Err(error) => return Err(error),
                Ok(None) => {}
            }
            if Instant::now() >= deadline {
                return Err(Error::Pipeline("hardware encoder did not finish".into()));
            }
        }
    }
}

fn validate(settings: &EncoderSettings, pixels: &[u8]) -> Result<()> {
    let length = usize::try_from(settings.width)
        .ok()
        .and_then(|w| w.checked_mul(settings.height as usize))
        .and_then(|n| n.checked_mul(4));
    if settings.width == 0
        || settings.height == 0
        || length != Some(pixels.len())
        || !settings.fps.is_finite()
        || !(0.001..=1000.0).contains(&settings.fps)
        || settings.bitrate_bps == 0
        || (settings.max_bitrate_bps != 0 && settings.max_bitrate_bps < settings.bitrate_bps)
        || !settings.codec.accepts_profile(settings.profile)
    {
        return Err(Error::Pipeline("invalid hardware encoder input".into()));
    }
    Ok(())
}

fn description(settings: &EncoderSettings, factory: &str) -> String {
    let bitrate = settings.bitrate_bps.div_ceil(1000);
    let baseline = settings.profile == "constrained-baseline";
    let hardware = if factory.starts_with("nv") {
        let codec_options = match settings.codec {
            Codec::H264 => format!("bframes=0 cabac={}", !baseline),
            Codec::H265 | Codec::Av1 => "bframes=0".into(),
        };
        format!(
            "{factory} name=hardware bitrate={bitrate} max-bitrate={} rc-mode=cbr \
            rc-lookahead=0 zerolatency=true {codec_options}",
            settings.max_bitrate_bps.div_ceil(1000),
        )
    } else {
        let codec_options = match settings.codec {
            Codec::H264 => format!(
                "b-frames=0 cabac={} dct8x8={}",
                !baseline,
                settings.profile == "high"
            ),
            Codec::H265 => "b-frames=0".into(),
            // Unlike H26x, VA AV1 uses hierarchical golden-frame groups. Level
            // one disables future references so an idle desktop emits promptly.
            Codec::Av1 => "hierarchical-level=1".into(),
        };
        format!("{factory} name=hardware bitrate={bitrate} rate-control=cbr {codec_options}")
    };
    let media_type = settings.codec.media_type();
    let parser = settings.codec.parser();
    let parser_options = match settings.codec {
        Codec::H264 | Codec::H265 => " config-interval=-1",
        Codec::Av1 => "",
    };
    let output_caps = settings.codec.output_caps();
    format!(
        "appsrc name=input is-live=true format=time block=false max-buffers=4 \
         caps=video/x-raw,format=BGRA,width={},height={},framerate={}/1000 ! \
         videoconvert ! video/x-raw,format=NV12 ! {hardware} ! \
         {media_type},profile={} ! {parser}{parser_options} ! {output_caps} ! \
         appsink name=frames sync=false max-buffers=4 drop=false \
         enable-last-sample=false wait-on-eos=false",
        settings.width,
        settings.height,
        (settings.fps * 1000.0).round() as u32,
        settings.profile
    )
}

#[cfg(test)]
mod tests {
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
    #[ignore = "requires GStreamer and a working VA-API or NVENC hardware encoder"]
    fn advertised_hardware_encodes_and_decodes_idle_keyframes() {
        let codecs: Vec<_> = Codec::ALL
            .into_iter()
            .filter(|codec| crate::has_encoder(*codec))
            .collect();
        assert!(
            !codecs.is_empty(),
            "hardware smoke requires at least one advertised codec"
        );
        for codec in codecs {
            hardware_encodes_one_frame_and_idle_keyframe(codec);
        }
    }

    fn hardware_encodes_one_frame_and_idle_keyframe(codec: Codec) {
        let pixels = vec![100; 320 * 240 * 4];
        let (mut encoder, first) = Encoder::start(&settings(codec), &pixels, 0)
            .unwrap_or_else(|error| panic!("{codec:?}: {error}"));
        assert!(first[0].is_keyframe);
        if codec != Codec::Av1 {
            assert!(first[0].data.starts_with(&[0, 0, 0, 1]));
        }
        decode_frame(codec, &first[0]);
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
        decode_frame(codec, &packets[0]);
        encoder.flush().unwrap();
        println!(
            "{codec:?}: {} encoded/decoded initial and requested idle keyframes",
            encoder.factory
        );
    }

    fn decode_frame(codec: Codec, packet: &EncodedFrame) {
        let api = ffi::api().unwrap();
        let candidates: &[&str] = match codec {
            Codec::H264 => &["vah264dec", "nvh264dec", "avdec_h264"],
            Codec::H265 => &["vah265dec", "nvh265dec", "avdec_h265"],
            Codec::Av1 => &["vaav1dec", "nvav1dec", "dav1ddec", "av1dec"],
        };
        let decoder = candidates
            .iter()
            .find(|name| api.has_factory(name))
            .expect("hardware smoke also requires a matching decoder plugin");
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
        for channel in &pixels[..3] {
            assert!(channel.abs_diff(100) <= 5);
        }
    }
}
