//! Ported from dsh0416/desk-fleet, commit e4b963274b4afae8a7b8065d9efe5c6770bf9339.
//!
//! Safe high-level Rust wrapper around NVIDIA NVENC hardware video encoder.
//!
//! This crate manages an NVENC session using D3D11 capture textures.
//! The underlying NVENC
//! library is loaded at runtime via `libloading` (see [`deskfleet_nvenc_sys`]),
//! so no NVIDIA SDK binaries need to be shipped.
//!
//! # Platform support
//!
//! - **Windows**: loads `nvEncodeAPI64.dll` from the NVIDIA driver.
//!
//! Other targets compile an empty crate; no GPU is initialized at startup.

#![cfg(target_os = "windows")]
#![allow(unsafe_code, clippy::field_reassign_with_default)]

pub mod d3d11;
mod error;
mod rate_control;

pub use d3d11::D3D11Encoder;
pub use error::NvEncError;

/// Check whether NVENC is available on the current system.
///
/// This attempts to load the NVENC library and query the driver version.
/// Returns `true` if NVENC can be used.
#[must_use]
pub fn is_available() -> bool {
    deskfleet_nvenc_sys::NvEncApi::load().is_some()
}

/// Query the codecs supported by NVENC using an explicit device.
///
/// Pass a valid device pointer and the matching device type
/// (e.g. `NV_ENC_DEVICE_TYPE_DIRECTX` + an `ID3D11Device` pointer).
///
/// # Safety
///
/// `device` must be a valid device pointer of the given `device_type`
/// and must remain alive for the duration of this call.
#[must_use]
pub unsafe fn supported_codecs_for_device(
    device: *mut std::os::raw::c_void,
    device_type: deskfleet_nvenc_sys::NV_ENC_DEVICE_TYPE,
) -> Vec<SupportedCodec> {
    let api = match deskfleet_nvenc_sys::NvEncApi::load() {
        Some(api) => api,
        None => return Vec::new(),
    };

    let fns = match api.create_function_list() {
        Ok(fns) => fns,
        Err(_) => return Vec::new(),
    };

    let open = match fns.nvEncOpenEncodeSessionEx {
        Some(f) => f,
        None => return Vec::new(),
    };

    let mut params = deskfleet_nvenc_sys::NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS::default();
    params.version = deskfleet_nvenc_sys::NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    params.apiVersion = deskfleet_nvenc_sys::NVENCAPI_VERSION;
    params.deviceType = device_type;
    params.device = device;

    let Some(destroy) = fns.nvEncDestroyEncoder else {
        return Vec::new();
    };
    let mut encoder: *mut std::os::raw::c_void = std::ptr::null_mut();
    // SAFETY: the caller retains a valid device and the versioned parameter/output structs are initialized.
    let status = unsafe { open(&raw mut params, &raw mut encoder) };

    if status != deskfleet_nvenc_sys::NVENCSTATUS::NV_ENC_SUCCESS || encoder.is_null() {
        return Vec::new();
    }

    let codecs = query_codecs_from_session(&fns, encoder);

    // SAFETY: this call releases the successfully opened temporary query session.
    unsafe {
        let _ = destroy(encoder);
    }

    codecs
}

/// A codec that is supported by the local NVENC hardware.
#[derive(Debug, Clone)]
pub struct SupportedCodec {
    pub name: String,
    pub guid: deskfleet_nvenc_sys::GUID,
}

// ── Helpers ───────────────────────────────────────────────────────────

/// Query supported codecs from an open NVENC encoder session.
fn query_codecs_from_session(
    fns: &deskfleet_nvenc_sys::NV_ENCODE_API_FUNCTION_LIST,
    encoder: *mut std::os::raw::c_void,
) -> Vec<SupportedCodec> {
    let codec_guids = [
        (deskfleet_nvenc_sys::NV_ENC_CODEC_H264_GUID, "H.264"),
        (deskfleet_nvenc_sys::NV_ENC_CODEC_HEVC_GUID, "H.265"),
        (deskfleet_nvenc_sys::NV_ENC_CODEC_AV1_GUID, "AV1"),
    ];

    let mut codecs = Vec::new();

    for &(guid, name) in &codec_guids {
        let mut guid_count: u32 = 0;
        let Some(get_count) = fns.nvEncGetEncodeGUIDCount else {
            return Vec::new();
        };
        // SAFETY: the loaded function receives this live session and correctly versioned, initialized NVENC structures.
        let status = unsafe { get_count(encoder, &raw mut guid_count) };
        if status != deskfleet_nvenc_sys::NVENCSTATUS::NV_ENC_SUCCESS || guid_count == 0 {
            continue;
        }

        let mut guids = vec![deskfleet_nvenc_sys::GUID::default(); guid_count as usize];
        let mut actual_count: u32 = 0;
        let Some(get_guids) = fns.nvEncGetEncodeGUIDs else {
            return Vec::new();
        };
        // SAFETY: the loaded function receives this live session and correctly versioned, initialized NVENC structures.
        let status = unsafe {
            get_guids(
                encoder,
                guids.as_mut_ptr(),
                guid_count,
                &raw mut actual_count,
            )
        };
        if status != deskfleet_nvenc_sys::NVENCSTATUS::NV_ENC_SUCCESS {
            continue;
        }

        let found = guids[..actual_count as usize]
            .iter()
            .any(|g| guids_equal(g, &guid));
        if found {
            codecs.push(SupportedCodec {
                name: name.to_string(),
                guid,
            });
        }
    }

    codecs
}

pub(crate) fn guids_equal(a: &deskfleet_nvenc_sys::GUID, b: &deskfleet_nvenc_sys::GUID) -> bool {
    a.Data1 == b.Data1 && a.Data2 == b.Data2 && a.Data3 == b.Data3 && a.Data4 == b.Data4
}

/// The result of encoding a single frame.
#[derive(Debug, Clone)]
pub struct EncodedFrame {
    /// Encoded bitstream data (Annex B for H.264/H.265, OBU for AV1).
    pub data: Vec<u8>,
    pub timestamp_ns: u64,
    pub is_keyframe: bool,
}
