//! macOS hardware encoding backend using `VideoToolbox`.

#![allow(unsafe_code)]

use std::ffi::c_void;
use std::ptr::{self, NonNull};
use std::sync::{Arc, Mutex};

use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, kCFTypeArrayCallBacks,
};
use objc2_core_media::{
    CMSampleBuffer, CMTime, CMTimeFlags, kCMVideoCodecType_AV1, kCMVideoCodecType_H264,
    kCMVideoCodecType_HEVC,
};
use objc2_core_video::CVPixelBuffer;
use objc2_video_toolbox::{
    VTCompressionSession, VTEncodeInfoFlags, VTSessionSetProperty,
    kVTCompressionPropertyKey_AllowFrameReordering, kVTCompressionPropertyKey_AverageBitRate,
    kVTCompressionPropertyKey_DataRateLimits, kVTCompressionPropertyKey_ExpectedFrameRate,
    kVTCompressionPropertyKey_MaxFrameDelayCount, kVTCompressionPropertyKey_ProfileLevel,
    kVTCompressionPropertyKey_RealTime, kVTEncodeFrameOptionKey_ForceKeyFrame,
    kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel, kVTProfileLevel_H264_High_AutoLevel,
    kVTProfileLevel_H264_Main_AutoLevel, kVTProfileLevel_HEVC_Main_AutoLevel,
    kVTProfileLevel_HEVC_Main10_AutoLevel,
    kVTVideoEncoderSpecification_EnableLowLatencyRateControl,
};

#[path = "macos/output.rs"]
mod output;
use output::output_callback;

#[cfg(test)]
#[path = "macos/tests.rs"]
mod tests;

use crate::error::EncoderError;
use crate::packet::EncodedPacket;
use crate::types::{Codec, EncoderConfig, H264Profile, H265Profile};

/// Shared state for collecting encoded packets from the `VideoToolbox` callback.
struct CallbackState {
    packets: Vec<EncodedPacket>,
    codec: Codec,
}

/// macOS `VideoToolbox` H.264/H.265/AV1 encoder.
pub struct MacOSEncoder {
    session: CFRetained<VTCompressionSession>,
    state: Arc<Mutex<CallbackState>>,
    timescale: i32,
    frame_duration: i64,
    force_next_keyframe: bool,
}

// SAFETY: VTCompressionSession is thread-safe (internal dispatch queue, documented for any-thread use).
#[allow(clippy::non_send_fields_in_send_ty)]
unsafe impl Send for MacOSEncoder {}

impl MacOSEncoder {
    pub fn new(config: &EncoderConfig) -> Result<Self, EncoderError> {
        if config.width == 0 || config.height == 0 {
            return Err(EncoderError::InvalidConfig(
                "width and height must be positive".into(),
            ));
        }
        if config.fps <= 0.0 {
            return Err(EncoderError::InvalidConfig("fps must be positive".into()));
        }

        let codec_type = match config.codec {
            Codec::H264 => kCMVideoCodecType_H264,
            Codec::H265 => kCMVideoCodecType_HEVC,
            Codec::AV1 => kCMVideoCodecType_AV1,
        };

        let state = Arc::new(Mutex::new(CallbackState {
            packets: Vec::new(),
            codec: config.codec,
        }));

        // The encoder retains state through session invalidation.
        let state_ptr = Arc::as_ptr(&state);

        let mut session: *mut VTCompressionSession = ptr::null_mut();

        let encoder_specification = CFDictionary::<CFString, CFBoolean>::from_slices(
            // SAFETY: the framework exports immutable constants with process lifetime.
            &[unsafe { kVTVideoEncoderSpecification_EnableLowLatencyRateControl }],
            // SAFETY: the framework exports immutable constants with process lifetime.
            &[unsafe { objc2_core_foundation::kCFBooleanTrue }.expect("kCFBooleanTrue is null")],
        );

        // SAFETY: the dictionary has the expected CF types, output storage is valid, and callback state outlives the session.
        let status = unsafe {
            VTCompressionSession::create(
                None,
                config.width.cast_signed(),
                config.height.cast_signed(),
                codec_type,
                Some(encoder_specification.as_ref()),
                None,
                None,
                Some(output_callback),
                state_ptr as *mut c_void,
                NonNull::new_unchecked(&raw mut session),
            )
        };

        if status != 0 {
            return Err(EncoderError::Platform(format!(
                "VTCompressionSessionCreate failed with OSStatus {status}"
            )));
        }

        if session.is_null() {
            return Err(EncoderError::Platform(
                "VTCompressionSessionCreate returned null session".into(),
            ));
        }

        // Wrap in CFRetained. The create call returns a +1 ref.
        // SAFETY: the successful Create call returned a non-null, owned CoreFoundation reference.
        let session = unsafe { CFRetained::from_raw(NonNull::new_unchecked(session)) };

        if let Err(error) = Self::configure_session(&session, config) {
            // SAFETY: this session is owned here and no frames have been submitted.
            unsafe { session.invalidate() };
            return Err(error);
        }

        // SAFETY: this owned VideoToolbox session and all frame/property references remain valid for the call.
        let status = unsafe { session.prepare_to_encode_frames() };
        if status != 0 {
            tracing::warn!(
                "VTCompressionSessionPrepareToEncodeFrames returned {status} (non-fatal)"
            );
        }

        let timescale: i32 = 1_000_000_000; // nanosecond timescale
        #[allow(clippy::cast_possible_truncation)] // intentional: ns-precision frame duration
        let frame_duration = (f64::from(timescale) / config.fps) as i64;

        Ok(Self {
            session,
            state,
            timescale,
            frame_duration,
            force_next_keyframe: false,
        })
    }

    fn configure_session(
        session: &VTCompressionSession,
        config: &EncoderConfig,
    ) -> Result<(), EncoderError> {
        // Cast session to VTSession (which is just CFType).
        let vt_session: &CFType = session.as_ref();

        // Profile level (AV1 has no profile constants in the current bindings,
        // so the encoder uses its default profile).
        match config.codec {
            Codec::H264 => {
                let profile: &CFString = match config.h264_profile {
                    // SAFETY: this owned VideoToolbox session and all frame/property references remain valid for the call.
                    H264Profile::ConstrainedBaseline => unsafe {
                        kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel
                    },
                    // SAFETY: the framework exports immutable constants with process lifetime.
                    H264Profile::Main => unsafe { kVTProfileLevel_H264_Main_AutoLevel },
                    // SAFETY: the framework exports immutable constants with process lifetime.
                    H264Profile::High => unsafe { kVTProfileLevel_H264_High_AutoLevel },
                };
                set_property(
                    vt_session,
                    // SAFETY: the framework exports immutable constants with process lifetime.
                    unsafe { kVTCompressionPropertyKey_ProfileLevel },
                    Some(profile.as_ref()),
                )?;
            }
            Codec::H265 => {
                let profile: &CFString = match config.h265_profile {
                    // SAFETY: the framework exports immutable constants with process lifetime.
                    H265Profile::Main => unsafe { kVTProfileLevel_HEVC_Main_AutoLevel },
                    // SAFETY: the framework exports immutable constants with process lifetime.
                    H265Profile::Main10 => unsafe { kVTProfileLevel_HEVC_Main10_AutoLevel },
                };
                set_property(
                    vt_session,
                    // SAFETY: the framework exports immutable constants with process lifetime.
                    unsafe { kVTCompressionPropertyKey_ProfileLevel },
                    Some(profile.as_ref()),
                )?;
            }
            Codec::AV1 => {
                // No profile level constants available for AV1 in the current bindings.
                // VideoToolbox will use its default AV1 profile (Main).
            }
        }

        // Real-time mode.
        set_property_bool(
            vt_session,
            // SAFETY: the framework exports immutable constants with process lifetime.
            unsafe { kVTCompressionPropertyKey_RealTime },
            config.realtime,
        )?;

        // RTP samples must stay in decode order without B-frame reordering.
        set_property_bool(
            vt_session,
            // SAFETY: the framework exports immutable constants with process lifetime.
            unsafe { kVTCompressionPropertyKey_AllowFrameReordering },
            false,
        )?;

        // Average bitrate.
        set_property_i64(
            vt_session,
            // SAFETY: the framework exports immutable constants with process lifetime.
            unsafe { kVTCompressionPropertyKey_AverageBitRate },
            i64::from(config.bitrate_bps),
        )?;

        // Maximum bitrate (hard cap via `DataRateLimits`).
        if config.max_bitrate_bps > 0 {
            let bytes_per_second = i64::from(config.max_bitrate_bps / 8);
            let interval: f64 = 1.0; // 1-second window
            let cf_bytes = CFNumber::new_i64(bytes_per_second);
            let cf_interval = CFNumber::new_f64(interval);
            let values: [*const c_void; 2] = [
                ptr::from_ref::<CFType>(cf_bytes.as_ref()).cast(),
                ptr::from_ref::<CFType>(cf_interval.as_ref()).cast(),
            ];
            // SAFETY: these pointers reference live CFNumbers retained by the CFType array callbacks.
            let array = unsafe {
                CFArray::new(
                    None,
                    values.as_ptr().cast_mut(),
                    2,
                    &raw const kCFTypeArrayCallBacks,
                )
            };
            if let Some(arr) = array
                && let Err(e) = set_property(
                    vt_session,
                    // SAFETY: the framework exports immutable constants with process lifetime.
                    unsafe { kVTCompressionPropertyKey_DataRateLimits },
                    Some(arr.as_ref()),
                )
            {
                tracing::warn!("DataRateLimits not supported (non-fatal): {e}");
            }
        }

        // Expected frame rate.
        set_property_f64(
            vt_session,
            // SAFETY: the framework exports immutable constants with process lifetime.
            unsafe { kVTCompressionPropertyKey_ExpectedFrameRate },
            config.fps,
        )?;

        // Zero frame delay — force the encoder to output each frame immediately
        // rather than buffering for look-ahead.
        // Best-effort: some hardware encoders do not support this property.
        if let Err(e) = set_property_i64(
            vt_session,
            // SAFETY: the framework exports immutable constants with process lifetime.
            unsafe { kVTCompressionPropertyKey_MaxFrameDelayCount },
            0,
        ) {
            tracing::warn!("MaxFrameDelayCount 0 not supported (non-fatal): {e}");
        }

        Ok(())
    }

    /// Request that the next call to [`encode_pixel_buffer`](Self::encode_pixel_buffer)
    /// produces a keyframe (IDR / key frame).
    ///
    /// Typically called in response to a WebRTC PLI (Picture Loss Indication)
    /// or FIR (Full Intra Request).
    pub fn request_keyframe(&mut self) {
        self.force_next_keyframe = true;
    }

    /// Change the target and/or maximum bitrate on the live session.
    pub fn set_bitrate(
        &self,
        avg_bitrate_bps: u32,
        max_bitrate_bps: u32,
    ) -> Result<(), EncoderError> {
        let vt_session: &CFType = self.session.as_ref();

        set_property_i64(
            vt_session,
            // SAFETY: the framework exports immutable constants with process lifetime.
            unsafe { kVTCompressionPropertyKey_AverageBitRate },
            i64::from(avg_bitrate_bps),
        )?;

        if max_bitrate_bps > 0 {
            let bytes_per_second = i64::from(max_bitrate_bps / 8);
            let interval: f64 = 1.0;
            let cf_bytes = CFNumber::new_i64(bytes_per_second);
            let cf_interval = CFNumber::new_f64(interval);
            let values: [*const c_void; 2] = [
                ptr::from_ref::<CFType>(cf_bytes.as_ref()).cast(),
                ptr::from_ref::<CFType>(cf_interval.as_ref()).cast(),
            ];
            // SAFETY: these pointers reference live CFNumbers retained by the CFType array callbacks.
            let array = unsafe {
                CFArray::new(
                    None,
                    values.as_ptr().cast_mut(),
                    2,
                    &raw const kCFTypeArrayCallBacks,
                )
            };
            if let Some(arr) = array
                && let Err(e) = set_property(
                    vt_session,
                    // SAFETY: the framework exports immutable constants with process lifetime.
                    unsafe { kVTCompressionPropertyKey_DataRateLimits },
                    Some(arr.as_ref()),
                )
            {
                tracing::warn!("DataRateLimits update not supported (non-fatal): {e}");
            }
        }

        tracing::info!("bitrate updated: avg={avg_bitrate_bps} bps, max={max_bitrate_bps} bps");
        Ok(())
    }

    /// Change the target frame rate on the live session.
    pub fn set_fps(&mut self, fps: f64) -> Result<(), EncoderError> {
        if fps <= 0.0 {
            return Err(EncoderError::InvalidConfig("fps must be positive".into()));
        }
        let vt_session: &CFType = self.session.as_ref();
        set_property_f64(
            vt_session,
            // SAFETY: the framework exports immutable constants with process lifetime.
            unsafe { kVTCompressionPropertyKey_ExpectedFrameRate },
            fps,
        )?;
        #[allow(clippy::cast_possible_truncation)]
        {
            self.frame_duration = (f64::from(self.timescale) / fps) as i64;
        }
        Ok(())
    }

    /// Encode an original capture pixel buffer into H.264, H.265, or AV1.
    ///
    /// Uses asynchronous pipelining: submission returns without forcing
    /// synchronous completion, and packets are drained from callback state.
    pub fn encode_pixel_buffer(
        &mut self,
        pixel_buffer: &CVPixelBuffer,
        timestamp_ns: u64,
    ) -> Result<Vec<EncodedPacket>, EncoderError> {
        let pts = CMTime {
            value: timestamp_ns.cast_signed(),
            timescale: self.timescale,
            flags: CMTimeFlags::Valid,
            epoch: 0,
        };

        let duration = CMTime {
            value: self.frame_duration,
            timescale: self.timescale,
            flags: CMTimeFlags::Valid,
            epoch: 0,
        };

        // Build frame properties — if a keyframe was requested, set
        // kVTEncodeFrameOptionKey_ForceKeyFrame = true.
        let frame_props = if self.force_next_keyframe {
            self.force_next_keyframe = false;
            tracing::debug!("forcing keyframe on next encode");
            let cf_true =
                // SAFETY: the framework exports immutable constants with process lifetime.
                unsafe { objc2_core_foundation::kCFBooleanTrue }.expect("kCFBooleanTrue is null");
            // SAFETY: the framework exports immutable constants with process lifetime.
            let key: &CFString = unsafe { kVTEncodeFrameOptionKey_ForceKeyFrame };
            Some(CFDictionary::<CFString, CFType>::from_slices(
                &[key],
                &[cf_true.as_ref()],
            ))
        } else {
            None
        };

        // SAFETY: the original capture buffer is valid; VideoToolbox retains it
        // until asynchronous encoding finishes, preventing capture-pool reuse.
        let status = unsafe {
            self.session.encode_frame(
                pixel_buffer,
                pts,
                duration,
                frame_props.as_deref().map(AsRef::as_ref),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };

        if status != 0 {
            return Err(EncoderError::Platform(format!(
                "VTCompressionSessionEncodeFrame failed with OSStatus {status}"
            )));
        }

        // Drain the packets that the callback has produced.
        Ok(self.drain_packets())
    }

    /// Force the encoder to flush all pending frames and return them.
    pub fn flush(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        // SAFETY: this owned VideoToolbox session and all frame/property references remain valid for the call.
        let status = unsafe {
            self.session.complete_frames(CMTime {
                value: 0,
                timescale: 0,
                flags: CMTimeFlags(0), // invalid time = flush all
                epoch: 0,
            })
        };

        if status != 0 {
            return Err(EncoderError::Platform(format!(
                "VTCompressionSessionCompleteFrames failed with OSStatus {status}"
            )));
        }

        Ok(self.drain_packets())
    }

    pub(crate) fn drain_packets(&self) -> Vec<EncodedPacket> {
        let mut state = self.state.lock().expect("encoder state lock poisoned");
        std::mem::take(&mut state.packets)
    }
}

impl Drop for MacOSEncoder {
    fn drop(&mut self) {
        // Invalidate the session.
        // SAFETY: this is an owned session; invalidation completes callbacks before their state is dropped.
        unsafe { self.session.invalidate() };

        // invalidate() finishes callbacks before self.state is released.
    }
}

// ── Codec probing ─────────────────────────────────────────────────────

/// Probe which video codecs are supported by the platform encoder.
///
/// Creates a temporary `VTCompressionSession` for each codec type to
/// check whether the hardware encoder is available. Sessions are
/// immediately torn down after the check.
pub fn probe_supported_codecs() -> Vec<Codec> {
    let mut supported = Vec::new();

    for codec in Codec::ALL {
        if probe_single_codec(codec) {
            supported.push(codec);
        }
    }

    supported
}

fn probe_single_codec(codec: Codec) -> bool {
    let codec_type = match codec {
        Codec::H264 => kCMVideoCodecType_H264,
        Codec::H265 => kCMVideoCodecType_HEVC,
        Codec::AV1 => kCMVideoCodecType_AV1,
    };

    let mut session: *mut VTCompressionSession = ptr::null_mut();

    // SAFETY: the dictionary has the expected CF types, output storage is valid, and callback state outlives the session.
    let status = unsafe {
        VTCompressionSession::create(
            None,
            320,
            240,
            codec_type,
            None,
            None,
            None,
            Some(probe_output_callback),
            ptr::null_mut(),
            NonNull::new_unchecked(&raw mut session),
        )
    };

    if status == 0 && !session.is_null() {
        // Session created successfully — codec is supported.
        // Clean up: invalidate and release.
        // SAFETY: the successful Create call returned a non-null, owned CoreFoundation reference.
        unsafe {
            let retained = CFRetained::from_raw(NonNull::new_unchecked(session));
            retained.invalidate();
        }
        true
    } else {
        false
    }
}

/// No-op callback used only for codec capability probing.
unsafe extern "C-unwind" fn probe_output_callback(
    _: *mut c_void,
    _: *mut c_void,
    _: i32,
    _: VTEncodeInfoFlags,
    _: *mut CMSampleBuffer,
) {
}

// ── Property helpers ──────────────────────────────────────────────────

fn set_property(
    session: &CFType,
    key: &CFString,
    value: Option<&CFType>,
) -> Result<(), EncoderError> {
    // SAFETY: session, key and any value are live CoreFoundation objects of the required types.
    let status = unsafe { VTSessionSetProperty(session, key, value) };
    if status != 0 {
        Err(EncoderError::Platform(format!(
            "VTSessionSetProperty failed with OSStatus {status}"
        )))
    } else {
        Ok(())
    }
}

fn set_property_bool(session: &CFType, key: &CFString, value: bool) -> Result<(), EncoderError> {
    // SAFETY: this owned VideoToolbox session and all frame/property references remain valid for the call.
    let cf_bool = unsafe {
        if value {
            objc2_core_foundation::kCFBooleanTrue
        } else {
            objc2_core_foundation::kCFBooleanFalse
        }
    };
    let cf_type: &CFType = cf_bool.expect("kCFBoolean constant is null").as_ref();
    set_property(session, key, Some(cf_type))
}

fn set_property_i64(session: &CFType, key: &CFString, value: i64) -> Result<(), EncoderError> {
    let cf_num = CFNumber::new_i64(value);
    set_property(session, key, Some(cf_num.as_ref()))
}

fn set_property_f64(session: &CFType, key: &CFString, value: f64) -> Result<(), EncoderError> {
    let cf_num = CFNumber::new_f64(value);
    set_property(session, key, Some(cf_num.as_ref()))
}
