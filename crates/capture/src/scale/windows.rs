//! GPU-only BGRA scaling with a bounded pool of encoder input textures.
#![allow(unsafe_code)]

use std::mem::ManuallyDrop;
use std::sync::Arc;

use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT, D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
    D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D, ID3D11Device,
    ID3D11DeviceContext, ID3D11VideoContext1, ID3D11VideoDevice, ID3D11VideoProcessor,
    ID3D11VideoProcessorEnumerator,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_RATIONAL,
    DXGI_SAMPLE_DESC,
};
use windows::core::Interface;

use crate::surface::windows::{PlatformInner, TexturePool};
use crate::{CaptureError, Frame, NativeSurface};

pub(super) struct GpuScaler {
    processor: ID3D11VideoProcessor,
    enumerator: ID3D11VideoProcessorEnumerator,
    video_context: ID3D11VideoContext1,
    video_device: ID3D11VideoDevice,
    context: ID3D11DeviceContext,
    device: ID3D11Device,
    pool: Arc<TexturePool>,
    source_dimensions: (u32, u32),
    dimensions: (u32, u32),
}

impl GpuScaler {
    pub(super) fn matches(&self, frame: &Frame, width: u32, height: u32) -> bool {
        self.source_dimensions == (frame.width, frame.height)
            && self.dimensions == (width, height)
            && self.device.as_raw() == frame.surface().d3d11_device().as_raw()
    }

    pub(super) fn new(frame: &Frame, width: u32, height: u32) -> Result<Self, CaptureError> {
        let device = frame.surface().d3d11_device();
        let context = frame.surface().d3d11_context();
        let source = rectangle(frame.width, frame.height)?;
        let destination = rectangle(width, height)?;
        let video_device: ID3D11VideoDevice = device
            .cast()
            .map_err(|error| platform("query scaling video device", error))?;
        let video_context: ID3D11VideoContext1 = context
            .cast()
            .map_err(|error| platform("query scaling video context", error))?;
        // Equal nominal rates select spatial scaling only; timestamps retain the
        // capture rate and this processor does not interpolate temporal frames.
        let rate = DXGI_RATIONAL {
            Numerator: 1,
            Denominator: 1,
        };
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: rate,
            InputWidth: frame.width,
            InputHeight: frame.height,
            OutputFrameRate: rate,
            OutputWidth: width,
            OutputHeight: height,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        // SAFETY: the device is retained and desc is initialized for this call.
        let enumerator = unsafe { video_device.CreateVideoProcessorEnumerator(&desc) }
            .map_err(|error| platform("create scaling enumerator", error))?;
        // SAFETY: the enumerator is live and BGRA is a defined DXGI format.
        let support = unsafe { enumerator.CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM) }
            .map_err(|error| platform("check BGRA scaling", error))?;
        if support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT.0 as u32 == 0
            || support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.0 as u32 == 0
        {
            return Err(CaptureError::Unsupported(
                "D3D11 video processor cannot scale BGRA",
            ));
        }
        // SAFETY: enumerator belongs to this device; progressive input needs no
        // past or future frames, so processor index zero is sufficient.
        let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0) }
            .map_err(|error| platform("create scaling processor", error))?;
        // SAFETY: the processor/context share the retained device and all source
        // and destination rectangles are initialized and valid for these calls.
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
                DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
            );
            video_context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&source));
            video_context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&destination));
            video_context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&destination));
        }
        let pool = Arc::new(TexturePool::new());
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        // The pipeline retains its latest frame until replacement, while NVENC
        // retains registrations by texture pointer. Reuse a fixed pool so those
        // registrations cannot grow on every preview frame.
        for _ in 0..3 {
            let mut texture = None;
            // SAFETY: desc is initialized and output is writable COM storage.
            unsafe { device.CreateTexture2D(&desc, None, Some(&raw mut texture)) }
                .map_err(|error| platform("create scaled texture", error))?;
            pool.release(
                texture.ok_or_else(|| CaptureError::Platform("scaled texture was null".into()))?,
            );
        }
        Ok(Self {
            processor,
            enumerator,
            video_context,
            video_device,
            context: context.clone(),
            device: device.clone(),
            pool,
            source_dimensions: (frame.width, frame.height),
            dimensions: (width, height),
        })
    }

    pub(super) fn resize(&self, frame: &Frame) -> Result<Frame, CaptureError> {
        let output = self
            .pool
            .acquire()
            .ok_or_else(|| CaptureError::Platform("scaled texture pool is still in use".into()))?;
        // This wrapper returns the output to the pool on both error and success.
        let surface = NativeSurface {
            inner: PlatformInner {
                texture: output,
                device: self.device.clone(),
                context: self.context.clone(),
                pool: Some(Arc::clone(&self.pool)),
            },
        };
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
        // SAFETY: source and destination retain compatible BGRA textures on this
        // device; initialized descriptors select mip/array zero.
        unsafe {
            self.video_device.CreateVideoProcessorInputView(
                frame.surface().as_d3d11_texture(),
                &self.enumerator,
                &input_desc,
                Some(&raw mut input_view),
            )
        }
        .map_err(|error| platform("create scaling input view", error))?;
        // SAFETY: output is a live render-target texture belonging to this device.
        unsafe {
            self.video_device.CreateVideoProcessorOutputView(
                surface.as_d3d11_texture(),
                &self.enumerator,
                &output_desc,
                Some(&raw mut output_view),
            )
        }
        .map_err(|error| platform("create scaling output view", error))?;
        let input_view = input_view
            .ok_or_else(|| CaptureError::Platform("scaling input view was null".into()))?;
        let output_view = output_view
            .ok_or_else(|| CaptureError::Platform("scaling output view was null".into()))?;
        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: ManuallyDrop::new(Some(input_view)),
            ..Default::default()
        };
        // SAFETY: views retain textures through submission; progressive scaling
        // uses one stream without past/future surfaces or CPU memory.
        let result = unsafe {
            self.video_context.VideoProcessorBlt(
                &self.processor,
                &output_view,
                0,
                std::slice::from_ref(&stream),
            )
        };
        drop(ManuallyDrop::into_inner(stream.pInputSurface));
        result.map_err(|error| platform("scale BGRA texture", error))?;
        // SAFETY: submit scaling before the native encoder accesses the texture.
        unsafe { self.context.Flush() };
        Ok(Frame::new(
            self.dimensions.0,
            self.dimensions.1,
            self.dimensions.0 * 4,
            frame.pixel_format,
            frame.timestamp_ns,
            surface,
        ))
    }
}

fn rectangle(width: u32, height: u32) -> Result<RECT, CaptureError> {
    Ok(RECT {
        left: 0,
        top: 0,
        right: i32::try_from(width)
            .map_err(|_| CaptureError::InvalidConfig("scaling width is too large"))?,
        bottom: i32::try_from(height)
            .map_err(|_| CaptureError::InvalidConfig("scaling height is too large"))?,
    })
}

fn platform(operation: &str, error: windows::core::Error) -> CaptureError {
    CaptureError::Platform(format!("D3D11 {operation}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use windows::Win32::Graphics::Direct3D11::D3D11_SUBRESOURCE_DATA;

    #[test]
    #[ignore = "requires an interactive Windows desktop and D3D11 video processing; uses synthetic pixels"]
    fn scales_synthetic_pixels_and_reuses_a_bounded_texture_pool() {
        let display = crate::displays().unwrap().remove(0);
        let (device, context) = crate::create_d3d11_device_for_display(display.id).unwrap();
        let mut pixels = Vec::<u8>::with_capacity(640 * 360 * 4);
        for _ in 0..360 {
            for x in 0..640 {
                pixels.extend_from_slice(if x < 320 {
                    &[0, 0, 255, 255]
                } else {
                    &[255, 0, 0, 255]
                });
            }
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: 640,
            Height: 360,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            ..Default::default()
        };
        let initial = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr().cast(),
            SysMemPitch: 640 * 4,
            SysMemSlicePitch: 0,
        };
        let mut texture = None;
        // SAFETY: pixels supplies every initialized BGRA row for the synchronous
        // texture upload; the output points to writable COM interface storage.
        unsafe { device.CreateTexture2D(&desc, Some(&initial), Some(&raw mut texture)) }.unwrap();
        let frame = Frame::new(
            640,
            360,
            640 * 4,
            crate::PixelFormat::Bgra8,
            123_000,
            NativeSurface {
                inner: PlatformInner {
                    texture: texture.unwrap(),
                    device,
                    context,
                    pool: None,
                },
            },
        );
        let scaler = GpuScaler::new(&frame, 320, 180).unwrap();
        let mut pointers = HashSet::new();
        let mut retained = None;
        for _ in 0..12 {
            let scaled = scaler.resize(&frame).unwrap();
            assert_eq!(
                (scaled.width, scaled.height, scaled.stride),
                (320, 180, 1280)
            );
            assert_eq!(scaled.timestamp_ns, 123_000);
            let pixels = scaled.copy_pixels().unwrap();
            assert_eq!(pixels.len(), 320 * 180 * 4);
            assert_eq!(&pixels[80 * 4..80 * 4 + 3], &[0, 0, 255]);
            assert_eq!(&pixels[240 * 4..240 * 4 + 3], &[255, 0, 0]);
            pointers.insert(scaled.surface().as_raw_ptr() as usize);
            retained = Some(scaled);
        }
        assert!(pointers.len() <= 3);
        drop(retained);
    }
}
