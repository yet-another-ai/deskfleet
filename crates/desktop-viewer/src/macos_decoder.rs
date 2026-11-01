//! Worker-owned VideoToolbox H.264 decoding. Synchronous, non-temporal decoding
//! emits each picture before returning, including the final picture while idle.

#![allow(unsafe_code)]

use std::{
    cell::RefCell,
    ffi::c_void,
    ptr::{self, NonNull},
    sync::Mutex,
    time::{Duration, Instant},
};

use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFString};
use objc2_core_media::{CMFormatDescription, CMTime};
use objc2_core_video::{
    CVImageBuffer, kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_32BGRA,
};
use objc2_video_toolbox::{
    VTDecodeFrameFlags, VTDecodeInfoFlags, VTDecompressionOutputCallbackRecord,
    VTDecompressionSession, VTSessionSetProperty, kVTDecompressionPropertyKey_RealTime,
    kVTVideoDecoderBadDataErr, kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder,
    kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder,
};

use crate::{Error, Frame, h264::Assembler};

mod buffers;
#[cfg(test)]
mod tests;

pub(crate) struct RtpVideoDecoder(RefCell<Decoder>);

struct Decoder {
    assembler: Assembler,
    parameters: buffers::Parameters,
    session: Option<Session>,
    hardware: bool,
    request: bool,
    waiting: bool,
}

// The boxed callback slot has a stable address until invalidation. No picture
// queue lives inside VideoToolbox: DecodeFrame uses neither asynchronous nor
// temporal processing, and the worker consumes the one result before submitting.
type Output = Mutex<Option<Decoded>>;

struct Decoded {
    status: i32,
    frame: Result<Option<Frame>, Error>,
}

struct Session {
    raw: CFRetained<VTDecompressionSession>,
    format: CFRetained<CMFormatDescription>,
    output: Box<Output>,
}

impl RtpVideoDecoder {
    pub fn new(payload_type: u8) -> Result<Self, Error> {
        let hardware = match std::env::var("DESKFLEET_VIEWER_DECODER").as_deref() {
            Ok("auto") | Err(std::env::VarError::NotPresent) => true,
            Ok("software") => false,
            _ => return Err("DESKFLEET_VIEWER_DECODER must be auto or software".into()),
        };
        Ok(Self(RefCell::new(Decoder {
            assembler: Assembler::new(payload_type),
            parameters: buffers::Parameters::default(),
            session: None,
            hardware,
            request: false,
            waiting: true,
        })))
    }

    pub fn try_push(&self, packet: &[u8]) -> Result<bool, Error> {
        self.0
            .borrow_mut()
            .assembler
            .push(packet)
            .map_err(Into::into)
    }

    pub fn next_frame(&self, timeout: Duration) -> Result<Option<Frame>, Error> {
        let deadline = Instant::now() + timeout;
        loop {
            let mut decoder = self.0.borrow_mut();
            if let Some(unit) = decoder.assembler.poll(Instant::now())
                && let Some(frame) = decoder.decode(&unit.bytes, unit.timestamp)?
            {
                return Ok(Some(frame));
            }
            drop(decoder);
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(
                Duration::from_millis(1).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }

    pub fn take_keyframe_request(&self) -> bool {
        let mut decoder = self.0.borrow_mut();
        let requested = std::mem::take(&mut decoder.request);
        decoder.assembler.take_request() || requested
    }

    pub fn stop(&self) -> Result<(), Error> {
        self.0.borrow_mut().session = None;
        Ok(())
    }
}

impl Decoder {
    fn decode(&mut self, bytes: &[u8], timestamp: u32) -> Result<Option<Frame>, Error> {
        let picture = self.parameters.picture(bytes)?;
        if picture.changed {
            // SPS/PPS changes are applied at an IDR. The old session cannot
            // supply reference pictures for a newly configured bitstream.
            self.session = None;
            self.waiting = true;
        }
        if !picture.has_slice {
            return Ok(None);
        }
        if self.waiting && !picture.idr {
            self.request = true;
            return Ok(None);
        }
        if self.session.is_none() {
            self.session = Some(Session::new(&self.parameters, self.hardware)?);
        }
        let session = self
            .session
            .as_ref()
            .ok_or("missing VideoToolbox session")?;
        let sample = buffers::sample(&picture.avcc, timestamp, &session.format)?;
        *session
            .output
            .lock()
            .map_err(|_| "decoder output poisoned")? = None;
        let mut flags = VTDecodeInfoFlags::empty();
        // SAFETY: The sample owns its compressed bytes; the retained session
        // owns callback state. With BOTH flags clear, Apple guarantees decoding
        // and the callback complete before this call returns. No PTS scheduler,
        // temporal reordering, future frame, or EOS is needed to obtain output.
        let status = unsafe {
            session.raw.decode_frame(
                &sample,
                VTDecodeFrameFlags::empty(),
                ptr::null_mut(),
                &raw mut flags,
            )
        };
        if self.recover_bad_data(status) {
            return Ok(None);
        }
        buffers::check(status, "VTDecompressionSessionDecodeFrame")?;
        let session = self
            .session
            .as_ref()
            .ok_or("missing VideoToolbox session")?;
        let result = session
            .output
            .lock()
            .map_err(|_| "decoder output poisoned")?
            .take();
        let frame = match result {
            Some(result) => {
                if self.recover_bad_data(result.status) {
                    return Ok(None);
                }
                buffers::check(result.status, "VideoToolbox output")?;
                result.frame?
            }
            None if flags.contains(VTDecodeInfoFlags::FrameDropped) => None,
            None => return Err("VideoToolbox returned without synchronous output".into()),
        };
        self.waiting = false;
        Ok(frame)
    }

    fn recover_bad_data(&mut self, status: i32) -> bool {
        if status != kVTVideoDecoderBadDataErr {
            return false;
        }
        self.session = None;
        self.waiting = true;
        self.request = true;
        true
    }
}

impl Session {
    fn new(parameters: &buffers::Parameters, hardware: bool) -> Result<Self, Error> {
        let format = parameters.format()?;
        // SAFETY: These immutable framework constants have process lifetime.
        let (specification_key, enabled, pixel_format_key, realtime) = unsafe {
            (
                if hardware {
                    kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder
                } else {
                    kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder
                },
                if hardware {
                    objc2_core_foundation::kCFBooleanTrue
                } else {
                    objc2_core_foundation::kCFBooleanFalse
                }
                .ok_or("missing CoreFoundation boolean")?,
                kCVPixelBufferPixelFormatTypeKey,
                kVTDecompressionPropertyKey_RealTime,
            )
        };
        let specification =
            CFDictionary::<CFString, CFBoolean>::from_slices(&[specification_key], &[enabled]);
        let pixel_format = CFNumber::new_i64(i64::from(kCVPixelFormatType_32BGRA));
        let attributes = CFDictionary::<CFString, CFNumber>::from_slices(
            &[pixel_format_key],
            &[pixel_format.as_ref()],
        );
        let output = Box::new(Mutex::new(None));
        let callback = VTDecompressionOutputCallbackRecord {
            decompressionOutputCallback: Some(output_callback),
            decompressionOutputRefCon: ptr::from_ref(output.as_ref()).cast_mut().cast(),
        };
        let mut raw = ptr::null_mut();
        // SAFETY: Format and dictionaries have the expected CF types. Output
        // storage is writable; the boxed callback slot outlives the session.
        let status = unsafe {
            VTDecompressionSession::create(
                None,
                &format,
                Some(specification.as_ref()),
                Some(attributes.as_ref()),
                &raw const callback,
                NonNull::from(&mut raw),
            )
        };
        buffers::check(status, "VTDecompressionSessionCreate")?;
        let raw = NonNull::new(raw).ok_or("VideoToolbox returned no decoder")?;
        // SAFETY: The successful Create call returned an owned CF reference.
        let raw = unsafe { CFRetained::from_raw(raw) };
        let session = Self {
            raw,
            format,
            output,
        };
        // SAFETY: Immutable framework constant with process lifetime.
        let enabled = unsafe { objc2_core_foundation::kCFBooleanTrue }
            .ok_or("missing CoreFoundation boolean")?;
        // SAFETY: Session is retained and RealTime accepts a CFBoolean.
        buffers::check(
            unsafe { VTSessionSetProperty(session.raw.as_ref(), realtime, Some(enabled.as_ref())) },
            "VTSessionSetProperty(RealTime)",
        )?;
        tracing::info!(hardware, "VideoToolbox viewer decoder started");
        Ok(session)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // SAFETY: This worker owns the session, synchronous decode has returned,
        // and callback storage is still alive throughout invalidation.
        unsafe { self.raw.invalidate() };
    }
}

/// # Safety
/// `output` points to this session's live boxed Output. VideoToolbox supplies
/// either a valid image buffer for this callback's duration or a null pointer.
unsafe extern "C-unwind" fn output_callback(
    output: *mut c_void,
    _source: *mut c_void,
    status: i32,
    flags: VTDecodeInfoFlags,
    image: *mut CVImageBuffer,
    _timestamp: CMTime,
    _duration: CMTime,
) {
    // SAFETY: The session owns the boxed Output until invalidation completes.
    let output = unsafe { &*output.cast::<Output>() };
    let frame = if status != 0 || flags.contains(VTDecodeInfoFlags::FrameDropped) {
        Ok(None)
    } else if image.is_null() {
        Err("VideoToolbox returned no decoded image".into())
    } else {
        // SAFETY: The configured BGRA output is a pixel buffer and remains valid
        // during this callback. Readback copies all data before returning.
        buffers::rgba(unsafe { &*image }).map(Some)
    };
    *output.lock().unwrap_or_else(|error| error.into_inner()) = Some(Decoded { status, frame });
}
