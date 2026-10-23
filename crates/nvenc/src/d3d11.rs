//! NVENC hardware encoder using D3D11 textures as input (zero-copy).
//!
//! Instead of copying pixel data into system-memory input buffers, this
//! encoder registers D3D11 textures directly with NVENC, keeping frames
//! on the GPU throughout the capture → encode pipeline.

#![allow(unsafe_code, clippy::field_reassign_with_default)]

use crate::EncodedFrame;
use crate::error::NvEncError;
use crate::guids_equal;
use deskfleet_nvenc_sys::{
    GUID, NV_ENC_BUFFER_FORMAT, NV_ENC_CONFIG_VER, NV_ENC_CREATE_BITSTREAM_BUFFER,
    NV_ENC_CREATE_BITSTREAM_BUFFER_VER, NV_ENC_DEVICE_TYPE, NV_ENC_INITIALIZE_PARAMS,
    NV_ENC_INITIALIZE_PARAMS_VER, NV_ENC_INPUT_RESOURCE_TYPE, NV_ENC_LOCK_BITSTREAM,
    NV_ENC_LOCK_BITSTREAM_VER, NV_ENC_MAP_INPUT_RESOURCE, NV_ENC_MAP_INPUT_RESOURCE_VER,
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS, NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER,
    NV_ENC_OUTPUT_PTR, NV_ENC_PIC_FLAGS, NV_ENC_PIC_PARAMS, NV_ENC_PIC_PARAMS_VER,
    NV_ENC_PIC_STRUCT, NV_ENC_PIC_TYPE, NV_ENC_PRESET_CONFIG, NV_ENC_PRESET_CONFIG_VER,
    NV_ENC_REGISTER_RESOURCE, NV_ENC_REGISTER_RESOURCE_VER, NV_ENC_TUNING_INFO,
    NV_ENCODE_API_FUNCTION_LIST, NVENCAPI_VERSION, NVENCSTATUS, NvEncApi,
};
use std::collections::HashMap;
use std::os::raw::c_void;
use std::ptr;

/// A hardware-accelerated NVENC encoder that accepts D3D11 textures directly.
///
/// The NVENC session is opened with `NV_ENC_DEVICE_TYPE_DIRECTX`, so it can
/// register `ID3D11Texture2D` resources without any CPU-side pixel copies.
pub struct D3D11Encoder {
    /// The loaded NVENC API (keeps the shared library alive).
    _api: NvEncApi,
    /// The NVENC function table.
    fns: NV_ENCODE_API_FUNCTION_LIST,
    /// Opaque encoder handle.
    encoder: *mut c_void,
    /// Pre-allocated bitstream (output) buffer.
    output_buffer: NV_ENC_OUTPUT_PTR,
    /// Frame width in pixels.
    width: u32,
    /// Frame height in pixels.
    height: u32,
    /// Whether the next frame should be forced to a keyframe.
    force_keyframe: bool,
    /// Cache of registered NVENC resources keyed by the raw D3D11 texture
    /// pointer.  Resources are registered once on first use and reused for
    /// subsequent frames, avoiding the heavy per-frame
    /// register / unregister round-trip.
    registered_resources: HashMap<usize, *mut c_void>,
}

// Safety: NVENC session handles are thread-safe at the session level.
// We guarantee exclusive `&mut self` access for encode operations.
unsafe impl Send for D3D11Encoder {}

impl D3D11Encoder {
    /// Create a new NVENC encoder session backed by a D3D11 device.
    ///
    /// # Arguments
    ///
    /// * `d3d11_device` — raw pointer to the `ID3D11Device` used for capture.
    /// * `width` / `height` — frame dimensions in pixels.
    /// * `fps` — target frame rate.
    /// * `bitrate_bps` — target average bitrate in bits per second.
    /// * `max_bitrate_bps` — maximum bitrate (0 = same as average).
    /// * `codec_guid` — codec to use (e.g. `NV_ENC_CODEC_H264_GUID`).
    /// * `profile_guid` — profile to use (e.g. `NV_ENC_H264_PROFILE_HIGH_GUID`).
    /// * `preset_guid` — preset to use (e.g. `NV_ENC_PRESET_P4_GUID`).
    /// * `tuning_info` — tuning hint (e.g. `NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY`).
    ///
    /// # Safety
    ///
    /// `d3d11_device` must be a valid `ID3D11Device` COM pointer that
    /// outlives this encoder.
    #[allow(clippy::too_many_arguments)]
    pub unsafe fn new(
        d3d11_device: *mut c_void,
        width: u32,
        height: u32,
        fps: f64,
        bitrate_bps: u32,
        max_bitrate_bps: u32,
        codec_guid: GUID,
        profile_guid: GUID,
        preset_guid: GUID,
        tuning_info: NV_ENC_TUNING_INFO,
    ) -> Result<Self, NvEncError> {
        // 1. Load the NVENC library.
        let api = NvEncApi::load().ok_or(NvEncError::NotAvailable)?;

        // 2. Check driver version.
        let driver_version = api.max_supported_version().map_err(NvEncError::Api)?;
        if driver_version < deskfleet_nvenc_sys::NVENCAPI_MAX_VERSION {
            return Err(NvEncError::UnsupportedDriverVersion {
                driver: driver_version,
                required: deskfleet_nvenc_sys::NVENCAPI_MAX_VERSION,
            });
        }

        // 3. Get the function table.
        let fns = api.create_function_list().map_err(NvEncError::Api)?;

        let get_preset = fns
            .nvEncGetEncodePresetConfigEx
            .ok_or(NvEncError::NotAvailable)?;
        let init = fns.nvEncInitializeEncoder.ok_or(NvEncError::NotAvailable)?;
        let create_output = fns
            .nvEncCreateBitstreamBuffer
            .ok_or(NvEncError::NotAvailable)?;
        fns.nvEncDestroyEncoder.ok_or(NvEncError::NotAvailable)?;

        // 4. Open an encode session with the D3D11 device.
        let open = fns
            .nvEncOpenEncodeSessionEx
            .ok_or(NvEncError::NotAvailable)?;

        let mut session_params = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS::default();
        session_params.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
        session_params.apiVersion = NVENCAPI_VERSION;
        session_params.deviceType = NV_ENC_DEVICE_TYPE::NV_ENC_DEVICE_TYPE_DIRECTX;
        session_params.device = d3d11_device;

        let mut encoder: *mut c_void = ptr::null_mut();
        // SAFETY: the caller retains a valid device and the versioned parameter/output structs are initialized.
        let status = unsafe { open(&raw mut session_params, &raw mut encoder) };
        if status != NVENCSTATUS::NV_ENC_SUCCESS || encoder.is_null() {
            return Err(NvEncError::SessionOpenFailed(status));
        }

        // 5. Get the preset configuration as a starting point.

        let mut preset_config = NV_ENC_PRESET_CONFIG::default();
        preset_config.version = NV_ENC_PRESET_CONFIG_VER;
        preset_config.presetCfg.version = NV_ENC_CONFIG_VER;

        // SAFETY: the loaded function receives this live session and correctly versioned, initialized NVENC structures.
        let status = unsafe {
            get_preset(
                encoder,
                codec_guid,
                preset_guid,
                tuning_info,
                &raw mut preset_config,
            )
        };
        if status != NVENCSTATUS::NV_ENC_SUCCESS {
            // SAFETY: the handle belongs to this live session and is released once before unloading the driver.
            unsafe { destroy_encoder(&fns, encoder) };
            return Err(NvEncError::InitFailed(status));
        }

        let mut encode_config = preset_config.presetCfg;

        // ── Rate-control overrides for real-time desktop streaming ────

        // CBR gives predictable network behaviour.
        encode_config.rcParams.rateControlMode =
            deskfleet_nvenc_sys::_NV_ENC_PARAMS_RC_MODE::NV_ENC_PARAMS_RC_CBR;
        encode_config.rcParams.averageBitRate = bitrate_bps;
        encode_config.rcParams.maxBitRate = if max_bitrate_bps > 0 {
            max_bitrate_bps
        } else {
            bitrate_bps
        };
        // Zero reorder delay — no frame reordering latency.
        encode_config.rcParams.set_zeroReorderDelay(1);
        // Disable adaptive quantization for speed.
        encode_config.rcParams.set_enableAQ(0);

        encode_config.profileGUID = profile_guid;

        // ── GOP / structure overrides ─────────────────────────────────

        // No B-frames — I/P only for lowest latency.
        encode_config.frameIntervalP = 1;
        // Infinite GOP — IDR frames are inserted only on demand
        // (via request_keyframe), not automatically.
        encode_config.gopLength = deskfleet_nvenc_sys::NVENC_INFINITE_GOPLENGTH;

        // ── Codec-specific: emit SPS/PPS (or VPS) with every IDR ─────
        //
        // Essential for WebRTC: a client that joins mid-stream or
        // recovers from packet loss needs parameter sets to decode.
        let is_h264 = guids_equal(&codec_guid, &deskfleet_nvenc_sys::NV_ENC_CODEC_H264_GUID);
        let is_hevc = guids_equal(&codec_guid, &deskfleet_nvenc_sys::NV_ENC_CODEC_HEVC_GUID);
        let is_av1 = guids_equal(&codec_guid, &deskfleet_nvenc_sys::NV_ENC_CODEC_AV1_GUID);

        if is_h264 {
            // SAFETY: codec_guid selected H.264, so this is the active configuration union member.
            unsafe {
                encode_config
                    .encodeCodecConfig
                    .h264Config
                    .set_repeatSPSPPS(1);
                encode_config.encodeCodecConfig.h264Config.idrPeriod =
                    deskfleet_nvenc_sys::NVENC_INFINITE_GOPLENGTH;
            }
        } else if is_hevc {
            // SAFETY: codec_guid selected HEVC, so this is the active configuration union member.
            unsafe {
                encode_config
                    .encodeCodecConfig
                    .hevcConfig
                    .set_repeatSPSPPS(1);
                encode_config.encodeCodecConfig.hevcConfig.idrPeriod =
                    deskfleet_nvenc_sys::NVENC_INFINITE_GOPLENGTH;
            }
        } else if is_av1 {
            encode_config.encodeCodecConfig.av1Config.idrPeriod =
                deskfleet_nvenc_sys::NVENC_INFINITE_GOPLENGTH;
        }

        // 6. Initialize the encoder.

        let fps_num = (fps * 1000.0) as u32;
        let fps_den = 1000u32;

        let mut init_params = NV_ENC_INITIALIZE_PARAMS::default();
        init_params.version = NV_ENC_INITIALIZE_PARAMS_VER;
        init_params.encodeGUID = codec_guid;
        init_params.presetGUID = preset_guid;
        init_params.encodeWidth = width;
        init_params.encodeHeight = height;
        init_params.darWidth = width;
        init_params.darHeight = height;
        init_params.frameRateNum = fps_num;
        init_params.frameRateDen = fps_den;
        init_params.enablePTD = 1;
        init_params.encodeConfig = &raw mut encode_config;
        init_params.tuningInfo = tuning_info;

        // SAFETY: the handle belongs to this live session and is released once before unloading the driver.
        let status = unsafe { init(encoder, &raw mut init_params) };
        if status != NVENCSTATUS::NV_ENC_SUCCESS {
            // SAFETY: the handle belongs to this live session and is released once before unloading the driver.
            unsafe { destroy_encoder(&fns, encoder) };
            return Err(NvEncError::InitFailed(status));
        }

        // 7. Create an output bitstream buffer (no input buffer — textures
        //    are registered dynamically).

        let mut output_params = NV_ENC_CREATE_BITSTREAM_BUFFER::default();
        output_params.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;

        // SAFETY: the handle belongs to this live session and is released once before unloading the driver.
        let status = unsafe { create_output(encoder, &raw mut output_params) };
        if status != NVENCSTATUS::NV_ENC_SUCCESS {
            // SAFETY: the handle belongs to this live session and is released once before unloading the driver.
            unsafe { destroy_encoder(&fns, encoder) };
            return Err(NvEncError::BitstreamBufferFailed(status));
        }
        let output_buffer = output_params.bitstreamBuffer;

        tracing::info!(
            "NVENC D3D11 encoder created: {width}x{height} @ {fps:.1} fps, \
             bitrate={bitrate_bps} bps"
        );

        Ok(Self {
            _api: api,
            fns,
            encoder,
            output_buffer,
            width,
            height,
            force_keyframe: false,
            registered_resources: HashMap::new(),
        })
    }

    /// Encode a D3D11 texture.
    ///
    /// Textures are registered with NVENC on first use and cached for
    /// subsequent frames.  Only map / unmap is performed per frame.
    ///
    /// # Safety
    ///
    /// `texture_ptr` must be a valid `ID3D11Texture2D` COM pointer whose
    /// dimensions match this encoder's width and height.  The texture must
    /// remain alive until the encoder is dropped, because registrations
    /// are cached until then.
    pub unsafe fn encode_texture(
        &mut self,
        texture_ptr: *mut c_void,
        timestamp_ns: u64,
    ) -> Result<EncodedFrame, NvEncError> {
        let map = self
            .fns
            .nvEncMapInputResource
            .ok_or(NvEncError::NotAvailable)?;
        let unmap = self
            .fns
            .nvEncUnmapInputResource
            .ok_or(NvEncError::NotAvailable)?;
        let encode = self
            .fns
            .nvEncEncodePicture
            .ok_or(NvEncError::NotAvailable)?;

        // 1. Register the D3D11 texture (cached — only done once per texture).
        let key = texture_ptr as usize;
        let registered_resource = if let Some(&cached) = self.registered_resources.get(&key) {
            cached
        } else {
            let register = self
                .fns
                .nvEncRegisterResource
                .ok_or(NvEncError::NotAvailable)?;

            let mut reg = NV_ENC_REGISTER_RESOURCE::default();
            reg.version = NV_ENC_REGISTER_RESOURCE_VER;
            reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE::NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
            reg.width = self.width;
            reg.height = self.height;
            reg.resourceToRegister = texture_ptr;
            reg.bufferFormat = NV_ENC_BUFFER_FORMAT::NV_ENC_BUFFER_FORMAT_ARGB;
            reg.bufferUsage = deskfleet_nvenc_sys::NV_ENC_BUFFER_USAGE::NV_ENC_INPUT_IMAGE;

            // SAFETY: the caller retains this D3D11 texture for the session lifetime; registration dimensions match it.
            let status = unsafe { register(self.encoder, &raw mut reg) };
            if status != NVENCSTATUS::NV_ENC_SUCCESS {
                return Err(NvEncError::InputBufferFailed(status));
            }

            let handle = reg.registeredResource;
            self.registered_resources.insert(key, handle);
            handle
        };

        // 2. Map the registered resource to get an NVENC input handle.
        let mut map_resource = NV_ENC_MAP_INPUT_RESOURCE::default();
        map_resource.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
        map_resource.registeredResource = registered_resource;

        // SAFETY: the loaded function receives this live session and correctly versioned, initialized NVENC structures.
        let status = unsafe { map(self.encoder, &raw mut map_resource) };
        if status != NVENCSTATUS::NV_ENC_SUCCESS {
            return Err(NvEncError::LockFailed(status));
        }

        let mapped_resource = map_resource.mappedResource;

        // 3. Submit the frame for encoding.
        let mut pic_params = NV_ENC_PIC_PARAMS::default();
        pic_params.version = NV_ENC_PIC_PARAMS_VER;
        pic_params.inputBuffer = mapped_resource;
        pic_params.bufferFmt = map_resource.mappedBufferFmt;
        pic_params.inputWidth = self.width;
        pic_params.inputHeight = self.height;
        pic_params.outputBitstream = self.output_buffer;
        pic_params.inputTimeStamp = timestamp_ns;
        pic_params.pictureStruct = NV_ENC_PIC_STRUCT::NV_ENC_PIC_STRUCT_FRAME;

        if self.force_keyframe {
            // Bindgen represents this C enum as `i32`. The picture-params field is `u32`.
            pic_params.encodePicFlags = (NV_ENC_PIC_FLAGS::NV_ENC_PIC_FLAG_FORCEIDR.0
                | NV_ENC_PIC_FLAGS::NV_ENC_PIC_FLAG_OUTPUT_SPSPPS.0)
                as u32;
            self.force_keyframe = false;
        }

        // SAFETY: the loaded function receives this live session and correctly versioned, initialized NVENC structures.
        let encode_status = unsafe { encode(self.encoder, &raw mut pic_params) };

        // Locking the synchronous output waits for the GPU to finish with input.
        let output = if encode_status == NVENCSTATUS::NV_ENC_SUCCESS {
            self.read_output(timestamp_ns)
        } else {
            Err(NvEncError::EncodeFailed(encode_status))
        };
        // SAFETY: this mapping belongs to this encoder and output is complete.
        let status = unsafe { unmap(self.encoder, mapped_resource) };
        if status != NVENCSTATUS::NV_ENC_SUCCESS {
            return Err(NvEncError::LockFailed(status));
        }
        output
    }

    /// Flush the encoder (signal end of stream and drain remaining frames).
    pub fn flush(&mut self) -> Result<Vec<EncodedFrame>, NvEncError> {
        let encode = self
            .fns
            .nvEncEncodePicture
            .ok_or(NvEncError::NotAvailable)?;

        let mut pic_params = NV_ENC_PIC_PARAMS::default();
        pic_params.version = NV_ENC_PIC_PARAMS_VER;
        pic_params.encodePicFlags = NV_ENC_PIC_FLAGS::NV_ENC_PIC_FLAG_EOS.0 as u32;

        // SAFETY: the loaded function receives this live session and correctly versioned, initialized NVENC structures.
        let status = unsafe { encode(self.encoder, &raw mut pic_params) };

        if status != NVENCSTATUS::NV_ENC_SUCCESS {
            return Err(NvEncError::EncodeFailed(status));
        }
        // This synchronous, I/P-only pipeline reads every output before encode
        // returns. EOS produces no new output buffer to lock.
        Ok(Vec::new())
    }

    /// Request that the next frame be encoded as a keyframe (IDR).
    pub fn request_keyframe(&mut self) {
        self.force_keyframe = true;
    }

    // ── Internals ─────────────────────────────────────────────────────

    fn read_output(&self, timestamp_ns: u64) -> Result<EncodedFrame, NvEncError> {
        let lock_bitstream = self
            .fns
            .nvEncLockBitstream
            .ok_or(NvEncError::NotAvailable)?;
        let unlock_bitstream = self
            .fns
            .nvEncUnlockBitstream
            .ok_or(NvEncError::NotAvailable)?;

        let mut lock_params = NV_ENC_LOCK_BITSTREAM::default();
        lock_params.version = NV_ENC_LOCK_BITSTREAM_VER;
        lock_params.outputBitstream = self.output_buffer;

        // SAFETY: the successful lock returns a readable bitstream range, copied before unlocking.
        let status = unsafe { lock_bitstream(self.encoder, &raw mut lock_params) };
        if status != NVENCSTATUS::NV_ENC_SUCCESS {
            return Err(NvEncError::LockFailed(status));
        }

        // SAFETY: the successful lock returns a readable bitstream range, copied before unlocking.
        let data = unsafe {
            std::slice::from_raw_parts(
                lock_params.bitstreamBufferPtr.cast::<u8>(),
                lock_params.bitstreamSizeInBytes as usize,
            )
            .to_vec()
        };

        let is_keyframe = lock_params.pictureType == NV_ENC_PIC_TYPE::NV_ENC_PIC_TYPE_IDR
            || lock_params.pictureType == NV_ENC_PIC_TYPE::NV_ENC_PIC_TYPE_I;

        // SAFETY: the loaded function receives this live session and correctly versioned, initialized NVENC structures.
        let status = unsafe { unlock_bitstream(self.encoder, self.output_buffer) };
        if status != NVENCSTATUS::NV_ENC_SUCCESS {
            return Err(NvEncError::LockFailed(status));
        }

        Ok(EncodedFrame {
            data,
            timestamp_ns,
            is_keyframe,
        })
    }
}

impl Drop for D3D11Encoder {
    fn drop(&mut self) {
        // 1. Unregister all cached input resources.
        if let Some(unregister) = self.fns.nvEncUnregisterResource {
            for (_key, handle) in self.registered_resources.drain() {
                // SAFETY: the handle belongs to this live session and is released once before unloading the driver.
                unsafe {
                    let _ = unregister(self.encoder, handle);
                }
            }
        }

        // 2. Destroy the bitstream buffer, then the encoder session.
        if let Some(destroy_output) = self.fns.nvEncDestroyBitstreamBuffer {
            // SAFETY: the handle belongs to this live session and is released once before unloading the driver.
            unsafe {
                let _ = destroy_output(self.encoder, self.output_buffer);
            }
        }
        // SAFETY: the handle belongs to this live session and is released once before unloading the driver.
        unsafe {
            destroy_encoder(&self.fns, self.encoder);
        }
    }
}

/// Helper to destroy an NVENC encoder session.
///
/// # Safety
/// `encoder` must be a valid NVENC encoder handle.
unsafe fn destroy_encoder(fns: &NV_ENCODE_API_FUNCTION_LIST, encoder: *mut c_void) {
    if let Some(destroy) = fns.nvEncDestroyEncoder {
        // SAFETY: the handle belongs to this live session and is released once before unloading the driver.
        let _ = unsafe { destroy(encoder) };
    }
}
