//! Windows encoder backend using NVENC with D3D11 texture input.

#![allow(unsafe_code)]

use deskfleet_capture::Frame;
use std::collections::HashMap;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};
use windows::core::Interface;

use crate::error::EncoderError;
use crate::packet::EncodedPacket;
use crate::types::{Codec, EncoderConfig, H264Profile, H265Profile};

/// Windows hardware encoder wrapping [`deskfleet_nvenc::D3D11Encoder`].
///
/// The NVENC session is opened lazily on the first call to [`encode`](Self::encode)
/// so that the D3D11 device can be extracted from the capture frame's surface.
pub struct WindowsEncoder {
    config: EncoderConfig,
    inner: Option<deskfleet_nvenc::D3D11Encoder>,
    // Drop the encoder before releasing its device and registered textures.
    device: Option<ID3D11Device>,
    textures: HashMap<usize, ID3D11Texture2D>,
    pending_keyframe: bool,
}

impl WindowsEncoder {
    pub fn new(config: &EncoderConfig) -> Result<Self, EncoderError> {
        if !deskfleet_nvenc::is_available() {
            return Err(EncoderError::Unsupported(
                "NVENC is not available on this system",
            ));
        }

        Ok(Self {
            config: config.clone(),
            inner: None,
            device: None,
            textures: HashMap::new(),
            pending_keyframe: false,
        })
    }

    /// Lazily initialise the NVENC session using the D3D11 device from the
    /// first captured frame.
    fn ensure_encoder(&mut self, frame: &Frame) -> Result<(), EncoderError> {
        if let Some(device) = &self.device {
            if device.as_raw() != frame.surface().d3d11_device().as_raw() {
                return Err(EncoderError::InvalidConfig(
                    "frame belongs to a different D3D11 device".into(),
                ));
            }
            return Ok(());
        }

        let surface = frame.surface();
        let device = surface.d3d11_device();

        let device_ptr: *mut std::os::raw::c_void = device.as_raw();

        let (codec_guid, profile_guid) = map_codec_and_profile(&self.config);

        // SAFETY: self.device retains this device until after the encoder is dropped.
        let mut encoder = unsafe {
            deskfleet_nvenc::D3D11Encoder::new(
                device_ptr,
                self.config.width,
                self.config.height,
                self.config.fps,
                self.config.bitrate_bps,
                self.config.max_bitrate_bps,
                codec_guid,
                profile_guid,
                // Use P1 preset (fastest encode, best for real-time desktop).
                deskfleet_nvenc_sys::NV_ENC_PRESET_P1_GUID,
                deskfleet_nvenc_sys::NV_ENC_TUNING_INFO::NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,
            )
        }
        .map_err(|e| EncoderError::Platform(format!("NVENC D3D11: {e}")))?;

        if self.pending_keyframe {
            encoder.request_keyframe();
            self.pending_keyframe = false;
        }
        self.device = Some(device.clone());
        self.inner = Some(encoder);
        Ok(())
    }

    pub fn encode(&mut self, frame: &Frame) -> Result<Vec<EncodedPacket>, EncoderError> {
        self.ensure_encoder(frame)?;

        let encoder = self.inner.as_mut().expect("encoder initialised");

        let surface = frame.surface();
        let texture = surface.as_d3d11_texture();
        let texture_ptr: *mut std::os::raw::c_void = texture.as_raw();

        // NVENC caches registrations by pointer, so retain every registered
        // texture until the encoder unregisters it during Drop.
        self.textures
            .entry(texture_ptr as usize)
            .or_insert_with(|| texture.clone());
        // SAFETY: frame dimensions are checked by Encoder; the retained texture
        // and device remain valid through session teardown.
        let nvenc_frame = unsafe {
            encoder
                .encode_texture(texture_ptr, frame.timestamp_ns)
                .map_err(|e| EncoderError::Platform(format!("NVENC encode: {e}")))?
        };

        Ok(vec![EncodedPacket {
            data: nvenc_frame.data,
            timestamp_ns: nvenc_frame.timestamp_ns,
            duration_ns: (1_000_000_000.0 / self.config.fps) as u64,
            is_keyframe: nvenc_frame.is_keyframe,
        }])
    }

    pub fn flush(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        let Some(encoder) = self.inner.as_mut() else {
            return Ok(Vec::new());
        };

        let frames = encoder
            .flush()
            .map_err(|e| EncoderError::Platform(format!("NVENC flush: {e}")))?;

        Ok(frames
            .into_iter()
            .map(|f| EncodedPacket {
                data: f.data,
                timestamp_ns: f.timestamp_ns,
                duration_ns: (1_000_000_000.0 / self.config.fps) as u64,
                is_keyframe: f.is_keyframe,
            })
            .collect())
    }

    pub fn request_keyframe(&mut self) {
        if let Some(encoder) = self.inner.as_mut() {
            encoder.request_keyframe();
        } else {
            self.pending_keyframe = true;
        }
    }

    pub fn set_bitrate(
        &self,
        _avg_bitrate_bps: u32,
        _max_bitrate_bps: u32,
    ) -> Result<(), EncoderError> {
        Err(EncoderError::Unsupported(
            "live NVENC bitrate reconfiguration",
        ))
    }

    /// Probe NVENC on the selected display's D3D11 device.
    pub fn probe_supported_codecs(device: &ID3D11Device) -> Vec<Codec> {
        probe_codecs_via_d3d11(device)
    }
}

// ── Helpers ───────────────────────────────────────────────────────────

/// Query the supplied display adapter without creating a default-adapter device.
fn probe_codecs_via_d3d11(device: &ID3D11Device) -> Vec<Codec> {
    let device_ptr: *mut std::os::raw::c_void = device.as_raw();

    // SAFETY: the retained D3D11 device remains alive until the synchronous capability query returns.
    let codecs = unsafe {
        deskfleet_nvenc::supported_codecs_for_device(
            device_ptr,
            deskfleet_nvenc_sys::NV_ENC_DEVICE_TYPE::NV_ENC_DEVICE_TYPE_DIRECTX,
        )
    };

    codecs
        .into_iter()
        .filter_map(|sc| match sc.name.as_str() {
            "H.264" => Some(Codec::H264),
            "H.265" => Some(Codec::H265),
            "AV1" => Some(Codec::AV1),
            _ => None,
        })
        .collect()
}

/// Map the crate-level `Codec` and profile enums to NVENC GUIDs.
fn map_codec_and_profile(
    config: &EncoderConfig,
) -> (deskfleet_nvenc_sys::GUID, deskfleet_nvenc_sys::GUID) {
    match config.codec {
        Codec::H264 => {
            let profile = match config.h264_profile {
                H264Profile::ConstrainedBaseline => {
                    deskfleet_nvenc_sys::NV_ENC_H264_PROFILE_BASELINE_GUID
                }
                H264Profile::Main => deskfleet_nvenc_sys::NV_ENC_H264_PROFILE_MAIN_GUID,
                H264Profile::High => deskfleet_nvenc_sys::NV_ENC_H264_PROFILE_HIGH_GUID,
            };
            (deskfleet_nvenc_sys::NV_ENC_CODEC_H264_GUID, profile)
        }
        Codec::H265 => {
            let profile = match config.h265_profile {
                H265Profile::Main => deskfleet_nvenc_sys::NV_ENC_HEVC_PROFILE_MAIN_GUID,
                H265Profile::Main10 => deskfleet_nvenc_sys::NV_ENC_HEVC_PROFILE_MAIN10_GUID,
            };
            (deskfleet_nvenc_sys::NV_ENC_CODEC_HEVC_GUID, profile)
        }
        Codec::AV1 => (
            deskfleet_nvenc_sys::NV_ENC_CODEC_AV1_GUID,
            deskfleet_nvenc_sys::NV_ENC_AV1_PROFILE_MAIN_GUID,
        ),
    }
}
