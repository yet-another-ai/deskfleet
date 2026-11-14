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

/// Video encoder owned and polled on the native capture worker.
pub struct Encoder {
    pipeline: Pipeline,
    input: Object,
    element: Object,
    factory: &'static str,
    settings: EncoderSettings,
    in_flight: usize,
    force_keyframe: bool,
    draining: bool,
}

impl Encoder {
    /// Verify encoder candidates in priority order using the first real frame.
    pub fn start(
        settings: &EncoderSettings,
        pixels: &[u8],
        timestamp_ns: u64,
    ) -> Result<(Self, Vec<EncodedFrame>)> {
        Self::start_with(settings.codec.factories(), settings, pixels, timestamp_ns)
    }

    /// Start only x264 after the caller has exhausted its native hardware backends.
    pub fn start_x264(
        settings: &EncoderSettings,
        pixels: &[u8],
        timestamp_ns: u64,
    ) -> Result<(Self, Vec<EncodedFrame>)> {
        if settings.codec != Codec::H264 {
            return Err(Error::Pipeline("x264 only supports H.264".into()));
        }
        Self::start_with(&["x264enc"], settings, pixels, timestamp_ns)
    }

    fn start_with(
        factories: &[&'static str],
        settings: &EncoderSettings,
        pixels: &[u8],
        timestamp_ns: u64,
    ) -> Result<(Self, Vec<EncodedFrame>)> {
        validate(settings, pixels)?;
        let api = ffi::api()?;
        let mut errors = Vec::new();
        for &factory in factories.iter().filter(|name| api.has_factory(name)) {
            let attempt = (|| {
                let pipeline = Pipeline::new(&description(settings, factory))?;
                let input = pipeline.child(c"input")?;
                let element = pipeline.child(c"encoder")?;
                let mut encoder = Self {
                    pipeline,
                    input,
                    element,
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
                        "video encoder produced no first packet".into(),
                    ));
                }
                Ok((encoder, packets))
            })();
            match attempt {
                Ok(value) => {
                    tracing::info!(factory, codec = ?settings.codec, "GStreamer video encoder started");
                    return Ok(value);
                }
                Err(error) => errors.push(format!("{factory}: {error}")),
            }
        }
        if errors.is_empty() {
            Err(Error::Unavailable(format!(
                "no supported {:?} video encoder is installed",
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
            // SAFETY: element is a live encoder; event is owned above.
            if unsafe { (api.element_send_event)(self.element.ptr.as_ptr(), event) } == 0 {
                return Err(Error::Pipeline(
                    "video encoder rejected keyframe request".into(),
                ));
            }
            self.force_keyframe = false;
        }
        let (width, height) = input_size(&self.settings, self.factory);
        let row = width as usize * 4;
        let length = row * height as usize;
        // SAFETY: Null allocator/params select GStreamer's default allocator.
        let buffer = unsafe {
            (api.buffer_new_allocate)(std::ptr::null_mut(), length, std::ptr::null_mut())
        };
        if buffer.is_null() {
            return Err(Error::Pipeline("cannot allocate encoder input".into()));
        }
        // SAFETY: We exclusively own the fresh buffer; validated pixels cover
        // every copied row. Public timestamp fields use GStreamer's stable ABI.
        let copied = unsafe {
            (*buffer).pts = timestamp_ns;
            (*buffer).dts = timestamp_ns;
            (*buffer).duration = self.frame_duration();
            if width == self.settings.width {
                (api.buffer_fill)(buffer, 0, pixels.as_ptr().cast(), length)
            } else {
                pixels
                    .chunks_exact(self.settings.width as usize * 4)
                    .take(height as usize)
                    .enumerate()
                    .map(|(y, line)| (api.buffer_fill)(buffer, y * row, line.as_ptr().cast(), row))
                    .sum()
            }
        };
        if copied != length {
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
        let timestamp_ns = sample.running_time(timestamp_ns)?;
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
            &self.element,
            c"bitrate",
            &bitrate_property(self.factory, average).to_string(),
        )?;
        if self.factory.starts_with("nv") {
            set_property(
                &self.element,
                c"max-bitrate",
                &bitrate_property(self.factory, maximum).to_string(),
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
                return Err(Error::Pipeline("video encoder did not finish".into()));
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
        return Err(Error::Pipeline("invalid video encoder input".into()));
    }
    Ok(())
}

// nvcodec labels these properties "kbit/sec" but multiplies them by 1024;
// VA and x264 use decimal kbps for the bitrate property.
// See GStreamer's sys/nvcodec/gstnvh264encoder.cpp (set_format/check_reconfigure):
// https://github.com/GStreamer/gstreamer/blob/1.26/subprojects/gst-plugins-bad/sys/nvcodec/gstnvh264encoder.cpp
fn bitrate_property(factory: &str, bits_per_second: u32) -> u32 {
    let unit = if factory.starts_with("nv") {
        1024
    } else {
        1000
    };
    bits_per_second.div_ceil(unit)
}

// x264 rejects odd 4:2:0 dimensions, so its input drops a trailing odd column
// and row.
fn input_size(settings: &EncoderSettings, factory: &str) -> (u32, u32) {
    let mask = if factory == "x264enc" { !1 } else { !0 };
    (settings.width & mask, settings.height & mask)
}

fn description(settings: &EncoderSettings, factory: &str) -> String {
    let bitrate = bitrate_property(factory, settings.bitrate_bps);
    let baseline = settings.profile == "constrained-baseline";
    let (width, height) = input_size(settings, factory);
    let encoder = if factory == "x264enc" {
        // Explicit properties override the preset and tuning, so CABAC and 8x8
        // transforms follow the negotiated profile. Zero-latency tuning turns
        // the two threads into slice threads, which add no frame delay.
        format!(
            "x264enc name=encoder bitrate={bitrate} speed-preset=ultrafast \
             tune=zerolatency threads=2 byte-stream=true bframes=0 cabac={} dct8x8={}",
            !baseline,
            settings.profile == "high"
        )
    } else if factory.starts_with("nv") {
        let codec_options = match settings.codec {
            Codec::H264 => format!("bframes=0 cabac={}", !baseline),
            Codec::H265 | Codec::Av1 => "bframes=0".into(),
        };
        format!(
            "{factory} name=encoder bitrate={bitrate} max-bitrate={} rc-mode=cbr \
            rc-lookahead=0 zerolatency=true {codec_options}",
            bitrate_property(factory, settings.max_bitrate_bps),
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
        format!("{factory} name=encoder bitrate={bitrate} rate-control=cbr {codec_options}")
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
         videoconvert ! video/x-raw,format=NV12 ! {encoder} ! \
         {media_type},profile={} ! {parser}{parser_options} ! {output_caps} ! \
         appsink name=frames sync=false max-buffers=4 drop=false \
         enable-last-sample=false wait-on-eos=false",
        width,
        height,
        (settings.fps * 1000.0).round() as u32,
        settings.profile
    )
}

#[cfg(test)]
mod tests;
