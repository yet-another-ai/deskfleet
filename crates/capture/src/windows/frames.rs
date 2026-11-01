//! Copy acquired DXGI frames into retained surfaces.
#![allow(unsafe_code)]

use super::device::create_pool_texture;
use crate::surface::windows::{PlatformInner, TexturePool};
use crate::{CaptureError, Frame, NativeSurface, PixelFormat};
use std::sync::{Arc, mpsc};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11DeviceContext, ID3D11Resource,
    ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIResource;
use windows::core::Interface;

/// Copy a DXGI resource into a pooled texture and return a [`Frame`].
pub(super) fn make_frame_from_resource(
    resource: &IDXGIResource,
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    texture_pool: &Arc<TexturePool>,
    timestamp_ns: u64,
    width: u32,
    height: u32,
) -> Result<Frame, CaptureError> {
    let src_texture: ID3D11Texture2D = resource.cast().map_err(|e| {
        CaptureError::Platform(format!("cast IDXGIResource to ID3D11Texture2D: {e}"))
    })?;

    let copy_texture = match texture_pool.acquire() {
        Some(tex) => tex,
        None => {
            return Err(CaptureError::Platform(
                "texture pool empty — skipping frame".into(),
            ));
        }
    };

    // SAFETY: Both textures belong to this device, have matching dimensions and
    // format, and remain retained during the protected context's GPU copy.
    unsafe {
        let dst_res: ID3D11Resource = copy_texture.cast().map_err(|e| {
            CaptureError::Platform(format!("cast copy_texture to ID3D11Resource: {e}"))
        })?;
        let src_res: ID3D11Resource = src_texture.cast().map_err(|e| {
            CaptureError::Platform(format!("cast src_texture to ID3D11Resource: {e}"))
        })?;
        context.CopyResource(&dst_res, &src_res);
    }

    Ok(Frame::new(
        width,
        height,
        width * 4,
        PixelFormat::Bgra8,
        timestamp_ns,
        NativeSurface {
            inner: PlatformInner {
                texture: copy_texture,
                device: device.clone(),
                context: context.clone(),
                pool: Some(Arc::clone(texture_pool)),
            },
        },
    ))
}

/// Copy a DXGI resource into a pooled texture and send it through the channel.
#[allow(clippy::too_many_arguments)]
pub(super) fn process_frame(
    resource: &IDXGIResource,
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    tx: &mpsc::SyncSender<(u64, Frame)>,
    texture_pool: &Arc<TexturePool>,
    timestamp_ns: u64,
    width: u32,
    height: u32,
    generation: u64,
) -> Result<(), CaptureError> {
    let src_texture: ID3D11Texture2D = resource.cast().map_err(|e| {
        CaptureError::Platform(format!("cast IDXGIResource to ID3D11Texture2D: {e}"))
    })?;

    let copy_texture = match texture_pool.acquire() {
        Some(tex) => tex,
        None => {
            return Err(CaptureError::Platform(
                "texture pool empty — skipping frame".into(),
            ));
        }
    };

    // SAFETY: Both textures belong to this device, have matching dimensions and
    // format, and remain retained during the protected context's GPU copy.
    unsafe {
        let dst_res: ID3D11Resource = copy_texture.cast().map_err(|e| {
            CaptureError::Platform(format!("cast copy_texture to ID3D11Resource: {e}"))
        })?;
        let src_res: ID3D11Resource = src_texture.cast().map_err(|e| {
            CaptureError::Platform(format!("cast src_texture to ID3D11Resource: {e}"))
        })?;
        context.CopyResource(&dst_res, &src_res);
    }

    let frame = Frame::new(
        width,
        height,
        width * 4,
        PixelFormat::Bgra8,
        timestamp_ns,
        NativeSurface {
            inner: PlatformInner {
                texture: copy_texture,
                device: device.clone(),
                context: context.clone(),
                pool: Some(Arc::clone(texture_pool)),
            },
        },
    );

    match tx.try_send((generation, frame)) {
        Ok(()) | Err(mpsc::TrySendError::Full(_)) => Ok(()),
        Err(mpsc::TrySendError::Disconnected(_)) => Err(CaptureError::StreamEnded),
    }
}

/// Update the persistent "last desktop" texture from a DXGI resource.
pub(super) fn update_last_desktop(
    resource: &IDXGIResource,
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    last_desktop: &mut Option<ID3D11Texture2D>,
    width: u32,
    height: u32,
) {
    let src: ID3D11Texture2D = match resource.cast() {
        Ok(t) => t,
        Err(_) => return,
    };

    if last_desktop.is_none() {
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
            BindFlags: 0,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        *last_desktop = create_pool_texture(device, &desc).ok();
    }

    if let Some(ld) = last_desktop.as_ref() {
        // SAFETY: Both textures belong to this device, have matching dimensions and
        // format, and remain retained during the protected context's GPU copy.
        unsafe {
            if let (Ok(dst), Ok(src_r)) =
                (ld.cast::<ID3D11Resource>(), src.cast::<ID3D11Resource>())
            {
                context.CopyResource(&dst, &src_r);
            }
        }
    }
}

/// Copy a texture into a pooled texture, wrap in a [`Frame`], and send.
/// Used for repeat frames when the desktop is idle.
#[allow(clippy::too_many_arguments)]
pub(super) fn send_frame_from_texture(
    src: &ID3D11Texture2D,
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    tx: &mpsc::SyncSender<(u64, Frame)>,
    texture_pool: &Arc<TexturePool>,
    timestamp_ns: u64,
    width: u32,
    height: u32,
    generation: u64,
) -> Result<(), CaptureError> {
    let copy_texture = match texture_pool.acquire() {
        Some(tex) => tex,
        None => {
            return Err(CaptureError::Platform(
                "texture pool empty — skipping frame".into(),
            ));
        }
    };

    // SAFETY: Both textures belong to this device, have matching dimensions and
    // format, and remain retained during the protected context's GPU copy.
    unsafe {
        let dst_res: ID3D11Resource = copy_texture.cast().map_err(|e| {
            CaptureError::Platform(format!("cast copy_texture to ID3D11Resource: {e}"))
        })?;
        let src_res: ID3D11Resource = src
            .cast()
            .map_err(|e| CaptureError::Platform(format!("cast src to ID3D11Resource: {e}")))?;
        context.CopyResource(&dst_res, &src_res);
    }

    let frame = Frame::new(
        width,
        height,
        width * 4, // BGRA stride
        PixelFormat::Bgra8,
        timestamp_ns,
        NativeSurface {
            inner: PlatformInner {
                texture: copy_texture,
                device: device.clone(),
                context: context.clone(),
                pool: Some(Arc::clone(texture_pool)),
            },
        },
    );

    match tx.try_send((generation, frame)) {
        Ok(()) | Err(mpsc::TrySendError::Full(_)) => Ok(()),
        Err(mpsc::TrySendError::Disconnected(_)) => Err(CaptureError::StreamEnded),
    }
}
