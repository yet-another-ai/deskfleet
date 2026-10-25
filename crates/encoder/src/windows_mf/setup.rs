//! Hardware MFT discovery and configuration on the capture adapter.

use std::{marker::PhantomData, rc::Rc};

use windows::Win32::Foundation::{E_NOTIMPL, E_POINTER, LUID};
use windows::Win32::Graphics::Direct3D11::ID3D11Device;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{
    COINIT_MULTITHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows::Win32::System::Variant::VARIANT;
use windows::core::{GUID, Interface};

use super::platform_error;
use crate::{EncoderConfig, EncoderError, H264Profile};

/// COM initialization is thread-affine; this guard and its encoder cannot move.
pub(super) struct Runtime(PhantomData<Rc<()>>);

impl Runtime {
    pub(super) fn new() -> Result<Self, EncoderError> {
        // SAFETY: The media worker owns this apartment initialization and balances
        // every successful call, including S_FALSE, on this same thread.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }
            .map_err(|error| platform_error("initialize COM", error))?;
        // SAFETY: MF startup/shutdown is reference counted, and the guard outlives
        // all transforms created by this worker.
        if let Err(error) = unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) } {
            // SAFETY: The COM initialization above succeeded on this thread.
            unsafe { CoUninitialize() };
            return Err(platform_error("start Media Foundation", error));
        }
        Ok(Self(PhantomData))
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        // SAFETY: All owned MFTs are dropped before this guard, on its creation thread.
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

pub(super) fn adapter_luid(device: &ID3D11Device) -> windows::core::Result<LUID> {
    let dxgi: IDXGIDevice = device.cast()?;
    // SAFETY: The retained device owns the returned adapter during this query.
    unsafe { Ok(dxgi.GetAdapter()?.GetDesc()?.AdapterLuid) }
}

pub(super) fn hardware_candidates(luid: LUID) -> windows::core::Result<Vec<IMFActivate>> {
    let mut attributes = None;
    let mut raw = std::ptr::null_mut();
    let mut count = 0;
    let input = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_NV12,
    };
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut luid_bytes = [0; 8];
    luid_bytes[..4].copy_from_slice(&luid.LowPart.to_le_bytes());
    luid_bytes[4..].copy_from_slice(&luid.HighPart.to_le_bytes());
    // SAFETY: All output pointers reference initialized local storage. MFTEnum2
    // allocates an array whose owned references are moved out before freeing it.
    unsafe {
        MFCreateAttributes(&mut attributes, 1)?;
        let attributes = attributes.ok_or_else(|| windows::core::Error::from_hresult(E_POINTER))?;
        attributes.SetBlob(&MFT_ENUM_ADAPTER_LUID, &luid_bytes)?;
        MFTEnum2(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input),
            Some(&output),
            &attributes,
            &mut raw,
            &mut count,
        )?;
        if raw.is_null() {
            return Ok(Vec::new());
        }
        let candidates = std::slice::from_raw_parts_mut(raw, count as usize)
            .iter_mut()
            .filter_map(Option::take)
            .collect();
        CoTaskMemFree(Some(raw.cast()));
        Ok(candidates)
    }
}

pub(super) fn probe(device: &ID3D11Device) -> Result<bool, EncoderError> {
    let _runtime = Runtime::new()?;
    let luid =
        adapter_luid(device).map_err(|error| platform_error("query display adapter", error))?;
    Ok(!hardware_candidates(luid)
        .map_err(|error| platform_error("enumerate hardware H.264 MFTs", error))?
        .is_empty())
}

/// Shut down failed activations as well as successfully streaming transforms.
pub(super) struct Activated {
    pub(super) transform: IMFTransform,
    activation: IMFActivate,
}

impl Drop for Activated {
    fn drop(&mut self) {
        // SAFETY: This activation owns the transform, and all calls have stopped.
        unsafe {
            let _ = self.activation.ShutdownObject();
        }
    }
}

pub(super) struct Session {
    pub(super) active: Activated,
    pub(super) events: IMFMediaEventGenerator,
    pub(super) codec: ICodecAPI,
    // Keep the manager and capture device alive throughout MFT shutdown.
    pub(super) _manager: IMFDXGIDeviceManager,
    pub(super) _device: ID3D11Device,
    pub(super) input_id: u32,
    pub(super) output_id: u32,
}

pub(super) fn set_codec_value(
    api: &ICodecAPI,
    key: &GUID,
    value: VARIANT,
) -> windows::core::Result<()> {
    // SAFETY: The scalar VARIANT remains alive for this synchronous call.
    unsafe { api.SetValue(key, &value) }
}

impl Session {
    pub(super) fn new(
        activation: IMFActivate,
        config: &EncoderConfig,
        device: &ID3D11Device,
    ) -> Result<Self, EncoderError> {
        // SAFETY: Activation occurs on the COM/MF worker and returns an owned MFT.
        let transform = unsafe { activation.ActivateObject::<IMFTransform>() }
            .map_err(|error| platform_error("activate hardware H.264 MFT", error))?;
        let active = Activated {
            transform,
            activation,
        };
        Self::configure(active, config, device)
            .map_err(|error| platform_error("configure hardware H.264 MFT", error))
    }

    fn configure(
        active: Activated,
        config: &EncoderConfig,
        device: &ID3D11Device,
    ) -> windows::core::Result<Self> {
        let transform = &active.transform;
        // SAFETY: All interfaces and out pointers are live on this COM worker;
        // no sample is submitted before types and the device manager are set.
        unsafe {
            let attributes = transform.GetAttributes()?;
            if attributes.GetUINT32(&MF_TRANSFORM_ASYNC)? == 0
                || attributes.GetUINT32(&MF_SA_D3D11_AWARE)? == 0
            {
                return Err(windows::core::Error::from_hresult(E_NOTIMPL));
            }
            attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
            let events = transform.cast::<IMFMediaEventGenerator>()?;
            let codec = transform.cast::<ICodecAPI>()?;
            let mut reset_token = 0;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut reset_token, &mut manager)?;
            let manager = manager.ok_or_else(|| windows::core::Error::from_hresult(E_POINTER))?;
            manager.ResetDevice(device, reset_token)?;
            transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)?;
            let mut input_count = 0;
            let mut output_count = 0;
            transform.GetStreamCount(&mut input_count, &mut output_count)?;
            if input_count != 1 || output_count != 1 {
                return Err(windows::core::Error::from_hresult(E_NOTIMPL));
            }
            let mut inputs = [0];
            let mut outputs = [0];
            if let Err(error) = transform.GetStreamIDs(&mut inputs, &mut outputs)
                && error.code() != E_NOTIMPL
            {
                return Err(error);
            }
            set_codec_value(
                &codec,
                &CODECAPI_AVEncCommonRateControlMode,
                VARIANT::from(eAVEncCommonRateControlMode_CBR.0 as u32),
            )?;
            set_codec_value(
                &codec,
                &CODECAPI_AVEncCommonMeanBitRate,
                VARIANT::from(config.bitrate_bps),
            )?;
            // Optional driver knobs; baseline itself forbids B pictures.
            let _ = set_codec_value(&codec, &CODECAPI_AVLowLatencyMode, VARIANT::from(true));
            let _ = set_codec_value(
                &codec,
                &CODECAPI_AVEncMPVDefaultBPictureCount,
                VARIANT::from(0u32),
            );
            let output = video_type(config, MFVideoFormat_H264)?;
            output.SetUINT32(&MF_MT_AVG_BITRATE, config.bitrate_bps)?;
            let profile = match config.h264_profile {
                H264Profile::ConstrainedBaseline => eAVEncH264VProfile_ConstrainedBase,
                H264Profile::Main => eAVEncH264VProfile_Main,
                H264Profile::High => eAVEncH264VProfile_High,
            };
            output.SetUINT32(&MF_MT_MPEG2_PROFILE, profile.0 as u32)?;
            if let Err(error) = transform.SetOutputType(outputs[0], &output, 0) {
                if !matches!(config.h264_profile, H264Profile::ConstrainedBaseline) {
                    return Err(error);
                }
                // Some hardware MFTs expose only Base; output SPS is validated
                // before delivery to ensure it actually is constrained baseline.
                output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base.0 as u32)?;
                transform.SetOutputType(outputs[0], &output, 0)?;
            }
            let input = video_type(config, MFVideoFormat_NV12)?;
            input.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
            input.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
            input.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
            input.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
            transform.SetInputType(inputs[0], &input, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            Ok(Self {
                active,
                events,
                codec,
                _manager: manager,
                _device: device.clone(),
                input_id: inputs[0],
                output_id: outputs[0],
            })
        }
    }

    pub(super) fn output_type(&self) -> windows::core::Result<IMFMediaType> {
        // SAFETY: The configured output stream belongs to this retained MFT.
        unsafe { self.active.transform.GetOutputCurrentType(self.output_id) }
    }
}

fn video_type(config: &EncoderConfig, subtype: GUID) -> windows::core::Result<IMFMediaType> {
    // SAFETY: A new local media type is populated with scalar attributes. Packed
    // sizes/ratios follow MF's UINT64 attribute representation.
    unsafe {
        let media = MFCreateMediaType()?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media.SetGUID(&MF_MT_SUBTYPE, &subtype)?;
        media.SetUINT64(
            &MF_MT_FRAME_SIZE,
            (u64::from(config.width) << 32) | u64::from(config.height),
        )?;
        media.SetUINT64(
            &MF_MT_FRAME_RATE,
            (((config.fps * 1000.0).round() as u64) << 32) | 1000,
        )?;
        media.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
        media.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        Ok(media)
    }
}
