//! GPU-only conversion from captured BGRA surfaces to encoder-ready NV12.

#![allow(unsafe_code)]

use std::mem::ManuallyDrop;

use deskfleet_capture::Frame;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT, D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
    D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D, ID3D11Device,
    ID3D11DeviceContext, ID3D11Texture2D, ID3D11VideoContext1, ID3D11VideoDevice,
    ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorEnumerator1,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::core::Interface;

use crate::error::EncoderError;

pub(super) struct GpuConverter {
    processor: ID3D11VideoProcessor,
    enumerator: ID3D11VideoProcessorEnumerator,
    video_context: ID3D11VideoContext1,
    video_device: ID3D11VideoDevice,
    context: ID3D11DeviceContext,
    device: ID3D11Device,
    width: u32,
    height: u32,
}

impl GpuConverter {
    pub(super) fn new(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        width: u32,
        height: u32,
    ) -> Result<Self, EncoderError> {
        if width == 0 || height == 0 || !width.is_multiple_of(2) || !height.is_multiple_of(2) {
            return Err(EncoderError::InvalidConfig(
                "NV12 conversion requires nonzero even dimensions".into(),
            ));
        }
        let rect = RECT {
            left: 0,
            top: 0,
            right: i32::try_from(width)
                .map_err(|_| EncoderError::InvalidConfig("video width is too large".into()))?,
            bottom: i32::try_from(height)
                .map_err(|_| EncoderError::InvalidConfig("video height is too large".into()))?,
        };
        let video_device: ID3D11VideoDevice = device
            .cast()
            .map_err(|error| platform("query video device", error))?;
        let video_context: ID3D11VideoContext1 = context
            .cast()
            .map_err(|error| platform("query video context", error))?;
        // Equal nominal rates disable rate conversion; actual capture timing is
        // carried by the MF samples and does not affect this spatial conversion.
        let rate = DXGI_RATIONAL {
            Numerator: 30,
            Denominator: 1,
        };
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: rate,
            InputWidth: width,
            InputHeight: height,
            OutputFrameRate: rate,
            OutputWidth: width,
            OutputHeight: height,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        // SAFETY: the device is retained and desc is initialized for this call.
        let enumerator = unsafe { video_device.CreateVideoProcessorEnumerator(&desc) }
            .map_err(|error| platform("create video processor enumerator", error))?;
        // SAFETY: the enumerator is live; these calls return format capability flags.
        let (input, output) = unsafe {
            (
                enumerator.CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM),
                enumerator.CheckVideoProcessorFormat(DXGI_FORMAT_NV12),
            )
        };
        let input = input.map_err(|error| platform("check BGRA input", error))?;
        let output = output.map_err(|error| platform("check NV12 output", error))?;
        if input & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT.0 as u32 == 0
            || output & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.0 as u32 == 0
        {
            return Err(EncoderError::Unsupported(
                "D3D11 video processor cannot convert BGRA to NV12",
            ));
        }
        let enumerator1: ID3D11VideoProcessorEnumerator1 = enumerator
            .cast()
            .map_err(|error| platform("query color conversion support", error))?;
        // SAFETY: both formats and color spaces are defined D3D11 values.
        let supported = unsafe {
            enumerator1.CheckVideoProcessorFormatConversion(
                DXGI_FORMAT_B8G8R8A8_UNORM,
                DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
                DXGI_FORMAT_NV12,
                DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
            )
        }
        .map_err(|error| platform("check BT.709 conversion", error))?;
        if !supported.as_bool() {
            return Err(EncoderError::Unsupported(
                "D3D11 video processor cannot convert full-range BGRA to limited-range BT.709 NV12",
            ));
        }
        // SAFETY: the enumerator belongs to video_device; index zero selects its
        // base processor. Progressive input needs no past or future frames.
        let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0) }
            .map_err(|error| platform("create video processor", error))?;
        // SAFETY: processor and context share the retained device, stream zero is
        // the only stream, and all rectangle pointers remain valid for these calls.
        unsafe {
            video_context.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            video_context.VideoProcessorSetStreamColorSpace1(
                &processor,
                0,
                DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
            );
            video_context.VideoProcessorSetOutputColorSpace1(
                &processor,
                DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
            );
            video_context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&rect));
            video_context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&rect));
            video_context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&rect));
        }
        Ok(Self {
            processor,
            enumerator,
            video_context,
            video_device,
            context: context.clone(),
            device: device.clone(),
            width,
            height,
        })
    }

    pub(super) fn convert(&self, frame: &Frame) -> Result<ID3D11Texture2D, EncoderError> {
        if frame.width != self.width || frame.height != self.height {
            return Err(EncoderError::InvalidConfig(
                "frame dimensions changed during NV12 conversion".into(),
            ));
        }
        if frame.surface().d3d11_device().as_raw() != self.device.as_raw() {
            return Err(EncoderError::InvalidConfig(
                "frame belongs to a different D3D11 device".into(),
            ));
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: self.width,
            Height: self.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        // Allocate per sample: an asynchronous MFT may still retain an earlier
        // converted texture when the next captured frame arrives.
        let mut output = None;
        // SAFETY: desc is initialized and output is writable COM interface storage.
        unsafe {
            self.device
                .CreateTexture2D(&desc, None, Some(&raw mut output))
        }
        .map_err(|error| platform("create NV12 texture", error))?;
        let output =
            output.ok_or_else(|| EncoderError::Platform("NV12 texture was null".into()))?;
        let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPIV {
                    MipSlice: 0,
                    ArraySlice: 0,
                },
            },
        };
        let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
            },
        };
        let mut input_view = None;
        let mut output_view = None;
        // SAFETY: the frame and output retain single-sample textures on this
        // device; descriptors select mip/array zero and outputs are writable.
        unsafe {
            self.video_device.CreateVideoProcessorInputView(
                frame.surface().as_d3d11_texture(),
                &self.enumerator,
                &input_desc,
                Some(&raw mut input_view),
            )
        }
        .map_err(|error| platform("create BGRA input view", error))?;
        // SAFETY: output is a live render-target texture belonging to this device.
        unsafe {
            self.video_device.CreateVideoProcessorOutputView(
                &output,
                &self.enumerator,
                &output_desc,
                Some(&raw mut output_view),
            )
        }
        .map_err(|error| platform("create NV12 output view", error))?;
        let input_view =
            input_view.ok_or_else(|| EncoderError::Platform("BGRA input view was null".into()))?;
        let output_view = output_view
            .ok_or_else(|| EncoderError::Platform("NV12 output view was null".into()))?;
        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: ManuallyDrop::new(Some(input_view)),
            ..Default::default()
        };
        // SAFETY: the views retain their textures through submission. Progressive
        // conversion uses one stream and no past/future surfaces or CPU memory.
        let result = unsafe {
            self.video_context.VideoProcessorBlt(
                &self.processor,
                &output_view,
                0,
                std::slice::from_ref(&stream),
            )
        };
        // windows-rs uses ManuallyDrop for embedded COM fields; release our view
        // on both success and failure after the call has stopped borrowing it.
        drop(ManuallyDrop::into_inner(stream.pInputSurface));
        result.map_err(|error| platform("convert BGRA to NV12", error))?;
        // SAFETY: flushing the live immediate context submits GPU work before
        // handing the texture to the MFT; it does not map or wait for CPU readback.
        unsafe { self.context.Flush() };
        Ok(output)
    }
}

fn platform(operation: &str, error: windows::core::Error) -> EncoderError {
    EncoderError::Platform(format!("D3D11 {operation}: {error}"))
}
