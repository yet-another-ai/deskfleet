//! Bounded RTP input and hardware decoding for the native desktop viewer.

#![allow(unsafe_code)]

use std::ffi::{c_int, c_ulong, c_void};
use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::capture::packed_bgra;
use crate::ffi::{self, Api};
use crate::pipeline::{Object, Pipeline};
use crate::{Codec, Error, Result};

const MAX_INPUT_BYTES: u64 = 1024 * 1024;
const MAX_INPUT_PACKETS: u64 = 256;
fn factories(codec: Codec, software: bool) -> &'static [&'static str] {
    match (codec, software) {
        (Codec::H264, false) => &["vah264dec", "nvh264dec", "vaapih264dec"],
        (Codec::H265, false) => &["vah265dec", "nvh265dec", "vaapih265dec"],
        (Codec::Av1, false) => &["vaav1dec", "nvav1dec"],
        (Codec::H264, true) => &["avdec_h264"],
        (Codec::H265, true) => &["avdec_h265"],
        (Codec::Av1, true) => &["av1dec", "dav1ddec", "avdec_av1"],
    }
}

fn software() -> Result<bool> {
    match std::env::var("DESKFLEET_VIEWER_DECODER").as_deref() {
        Ok("auto") | Err(std::env::VarError::NotPresent) => Ok(false),
        Ok("software") => Ok(true),
        _ => Err(Error::Unavailable(
            "DESKFLEET_VIEWER_DECODER must be auto or software".into(),
        )),
    }
}

pub fn supported_decoder_codecs() -> Result<Vec<Codec>> {
    let api = ffi::api()?;
    let software = software()?;
    Ok(Codec::ALL
        .into_iter()
        .filter(|codec| {
            [
                "appsrc",
                "appsink",
                "rtpjitterbuffer",
                "videoconvert",
                codec.parser(),
                depay(*codec),
            ]
            .into_iter()
            .all(|factory| api.has_factory(factory))
                && factories(*codec, software)
                    .iter()
                    .any(|factory| api.has_factory(factory))
        })
        .collect())
}

fn depay(codec: Codec) -> &'static str {
    match codec {
        Codec::H264 => "rtph264depay",
        Codec::H265 => "rtph265depay",
        Codec::Av1 => "rtpav1depay",
    }
}

/// Tightly packed RGBA pixels, owned independently of the decoder surface pool.
#[derive(Debug)]
pub struct DecodedFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// One negotiated RTP receive/decode pipeline, polled on its owning worker.
///
/// The jitterbuffer owns packet reordering and the depayloader waits for a
/// keyframe after loss. Decoded samples are never clock-paced: the native
/// presenter owns display timing. GPU surfaces are downloaded to RGBA in this
/// first implementation; the caller uploads those pixels for wgpu rendering.
pub struct RtpVideoDecoder {
    // Stop streaming tasks before removing their keyframe-event probe.
    pipeline: Pipeline,
    input: Object,
    probe: KeyframeProbe,
    factory: &'static str,
}

impl RtpVideoDecoder {
    /// Start a hardware decoder for a negotiated H.264 RTP payload type.
    ///
    /// `DESKFLEET_VIEWER_DECODER=software` explicitly selects the libav decoder
    /// for diagnostics. Hardware failures never silently select software.
    pub fn new(payload_type: u8) -> Result<Self> {
        Self::with_codec(payload_type, Codec::H264)
    }

    pub fn with_codec(payload_type: u8, codec: Codec) -> Result<Self> {
        let candidates = factories(codec, software()?);
        let api = ffi::api()?;
        let mut errors = Vec::new();
        for &factory in candidates.iter().filter(|name| api.has_factory(name)) {
            match Self::with_codec_factory(payload_type, codec, factory) {
                Ok(decoder) => {
                    tracing::info!(factory, "native viewer decoder started");
                    return Ok(decoder);
                }
                Err(error) => errors.push(format!("{factory}: {error}")),
            }
        }
        if errors.is_empty() {
            Err(Error::Unavailable(format!(
                "no selected {codec:?} decoder is installed"
            )))
        } else {
            Err(Error::Pipeline(errors.join("; ")))
        }
    }

    #[cfg(test)]
    fn with_factory(payload_type: u8, factory: &'static str) -> Result<Self> {
        Self::with_codec_factory(payload_type, Codec::H264, factory)
    }

    fn with_codec_factory(payload_type: u8, codec: Codec, factory: &'static str) -> Result<Self> {
        if payload_type > 127 {
            return Err(Error::Pipeline("invalid RTP payload type".into()));
        }
        let pipeline = Pipeline::new(&codec_description(payload_type, codec, factory))?;
        let input = pipeline.child(c"input")?;
        let probe = KeyframeProbe::new(&input)?;
        Ok(Self {
            pipeline,
            input,
            probe,
            factory,
        })
    }

    /// The selected GStreamer decoder factory, for diagnostics.
    pub fn factory(&self) -> &'static str {
        self.factory
    }

    /// Enqueue a complete RTP packet without blocking the caller.
    ///
    /// `false` leaves the packet with the caller: drain decoded output and retry
    /// the same packet. Dropping arbitrary compressed packets would invalidate
    /// reference pictures. The sole owner supplies packets in receive order;
    /// GStreamer performs sequence-number reordering.
    pub fn try_push(&self, packet: &[u8]) -> Result<bool> {
        self.pipeline.check_active()?;
        if packet.len() < 12 || packet.len() as u64 > MAX_INPUT_BYTES {
            return Err(Error::Pipeline("invalid RTP packet size".into()));
        }
        let api = self.input.api;
        // SAFETY: input retains a live appsrc. Only this owner enqueues; the
        // streaming thread can only reduce these queue levels between calls.
        let (bytes, packets) = unsafe {
            (
                (api.source_current_level_bytes)(self.input.ptr.as_ptr()),
                (api.source_current_level_buffers)(self.input.ptr.as_ptr()),
            )
        };
        if bytes.saturating_add(packet.len() as u64) > MAX_INPUT_BYTES
            || packets >= MAX_INPUT_PACKETS
        {
            return Ok(false);
        }
        // SAFETY: Null allocator and params request the default owned buffer.
        let buffer = unsafe {
            (api.buffer_new_allocate)(std::ptr::null_mut(), packet.len(), std::ptr::null_mut())
        };
        if buffer.is_null() {
            return Err(Error::Pipeline("cannot allocate decoder input".into()));
        }
        // SAFETY: The new buffer is exclusively owned; packet is valid through
        // this copy. appsrc supplies arrival timestamps via do-timestamp.
        let copied = unsafe { (api.buffer_fill)(buffer, 0, packet.as_ptr().cast(), packet.len()) };
        if copied != packet.len() {
            // SAFETY: The owned buffer has not been transferred to appsrc.
            unsafe { (api.mini_unref)(buffer.cast()) };
            return Err(Error::Pipeline("cannot fill decoder input".into()));
        }
        // SAFETY: input is appsrc and takes ownership for every return code.
        let flow = unsafe { (api.source_push_buffer)(self.input.ptr.as_ptr(), buffer) };
        if flow < 0 {
            self.pipeline.check_error()?;
            return Err(Error::Pipeline(format!(
                "decoder input flow failed ({flow})"
            )));
        }
        Ok(true)
    }

    /// Pull one decoded frame. A zero timeout only polls already available data.
    ///
    /// Call continuously on the receive/decode worker, independently of the
    /// window's presentation backpressure. The appsink has one FIFO position.
    pub fn next_frame(&self, timeout: Duration) -> Result<Option<DecodedFrame>> {
        let Some(sample) = self.pipeline.pull(timeout)? else {
            return Ok(None);
        };
        let (width, height) = sample.dimensions()?;
        let (offset, stride) = sample.layout(width, height)?;
        // RGBA has the same four-byte packed row layout as capture's BGRA.
        let pixels = packed_bgra(&sample.bytes()?, width, height, offset, stride)?;
        Ok(Some(DecodedFrame {
            width,
            height,
            pixels,
        }))
    }

    /// Consume a coalesced startup/loss-recovery request for an upstream PLI.
    pub fn take_keyframe_request(&self) -> bool {
        self.probe.requested.swap(false, Ordering::Relaxed)
    }

    pub fn stop(&self) -> Result<()> {
        self.pipeline.stop()
    }
}

fn codec_description(payload_type: u8, codec: Codec, factory: &str) -> String {
    // The small RTP reorder window handles packet jitter, not presentation PTS.
    // No queue or clock-synchronizing sink is added after decoding. An explicit
    // AU capsfilter makes wait-for-keyframe apply to complete H.264 pictures.
    let settings = match factory {
        // DeskFleet negotiates constrained baseline and sends no reordered
        // pictures. Flush the decoded picture immediately, including when the
        // desktop goes idle after a single update rather than filling the DPB.
        "vah264dec" | "nvh264dec" | "vah265dec" | "nvh265dec" => "compliance=flexible",
        "vaapih264dec" | "vaapih265dec" => "low-latency=true",
        "avdec_h264" | "avdec_h265" | "avdec_av1" => "max-threads=1",
        _ => "",
    };
    let encoding = match codec {
        Codec::H264 => "H264",
        Codec::H265 => "H265",
        Codec::Av1 => "AV1",
    };
    let depay = depay(codec);
    let caps = codec.output_caps();
    let parser = codec.parser();
    let recovery = "request-keyframe=true wait-for-keyframe=true";
    format!(
        "appsrc name=input is-live=true format=time do-timestamp=true block=false \
         max-bytes={MAX_INPUT_BYTES} max-buffers={MAX_INPUT_PACKETS} \
         caps=application/x-rtp,media=video,encoding-name={encoding},clock-rate=90000,payload={payload_type} ! \
         rtpjitterbuffer latency=10 faststart-min-packets=1 do-lost=true drop-on-latency=true ! \
         {depay} {recovery} ! {parser} ! {caps} ! \
         {factory} name=decoder {settings} ! videoconvert ! video/x-raw,format=RGBA ! \
         appsink name=frames sync=false max-buffers=1 drop=false \
         enable-last-sample=false wait-on-eos=false"
    )
}

struct KeyframeProbe {
    pad: Object,
    id: c_ulong,
    requested: Arc<AtomicBool>,
}

struct ProbeData {
    api: &'static Api,
    requested: Arc<AtomicBool>,
}

impl KeyframeProbe {
    fn new(input: &Object) -> Result<Self> {
        let api = input.api;
        // SAFETY: input is a live appsrc; its static src pad is returned owned.
        let ptr = unsafe { (api.element_get_static_pad)(input.ptr.as_ptr(), c"src".as_ptr()) };
        let pad = Object {
            ptr: NonNull::new(ptr)
                .ok_or_else(|| Error::Pipeline("decoder input has no source pad".into()))?,
            api,
        };
        let requested = Arc::new(AtomicBool::new(true));
        let data = Box::into_raw(Box::new(ProbeData {
            api,
            requested: Arc::clone(&requested),
        }));
        // SAFETY: This nonblocking event probe retains data until destroy_probe
        // is invoked. Its callbacks only access shared atomic state and static
        // function pointers; none of them can unwind across the C boundary.
        let id = unsafe {
            (api.pad_add_probe)(
                pad.ptr.as_ptr(),
                ffi::PAD_PROBE_EVENT_UPSTREAM,
                keyframe_event,
                data.cast(),
                destroy_probe,
            )
        };
        Ok(Self { pad, id, requested })
    }
}

impl Drop for KeyframeProbe {
    fn drop(&mut self) {
        // SAFETY: pad owns its reference; this wrapper alone owns the probe ID.
        // Removal invokes destroy_probe after GStreamer releases the callback.
        unsafe { (self.pad.api.pad_remove_probe)(self.pad.ptr.as_ptr(), self.id) };
    }
}

unsafe extern "C" fn keyframe_event(
    _pad: *mut ffi::Object,
    info: *mut ffi::Object,
    data: *mut c_void,
) -> c_int {
    // SAFETY: GStreamer passes the ProbeData retained by this installed probe
    // and a live event probe info valid for the duration of the callback.
    let data = unsafe { &*data.cast::<ProbeData>() };
    let event = unsafe { (data.api.pad_probe_info_get_event)(info) };
    // SAFETY: The returned event is borrowed from this upstream event probe.
    if !event.is_null() && unsafe { (data.api.is_force_key_unit)(event) } != 0 {
        data.requested.store(true, Ordering::Relaxed);
    }
    ffi::PAD_PROBE_OK
}

unsafe extern "C" fn destroy_probe(data: *mut c_void) {
    // SAFETY: GStreamer calls this once for the box transferred at installation.
    drop(unsafe { Box::from_raw(data.cast::<ProbeData>()) });
}

#[cfg(test)]
mod tests;
