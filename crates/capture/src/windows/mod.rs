//! Windows screen capture using the DXGI Desktop Duplication API.

#![allow(unsafe_code)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Instant;

use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D};
use windows::Win32::Graphics::Dxgi::{
    DXGI_OUTDUPL_FRAME_INFO, IDXGIOutputDuplication, IDXGIResource,
};

use crate::AudioFrame;
use crate::error::CaptureError;
use crate::frame::Frame;
use crate::surface::windows::TexturePool;
use crate::types::{CaptureConfig, Display};

mod device;
mod frames;
pub use device::{create_d3d11_device, displays};
use device::{create_duplication, find_dxgi_output, pre_allocate_pool, try_recreate_duplication};
use frames::{
    make_frame_from_resource, process_frame, send_frame_from_texture, update_last_desktop,
};

/// `DXGI_ERROR_WAIT_TIMEOUT` — `AcquireNextFrame` timed out with no new frame.
const DXGI_ERR_WAIT_TIMEOUT: windows::core::HRESULT = windows::core::HRESULT(0x887A0027_u32 as i32);

/// `DXGI_ERROR_ACCESS_LOST` — desktop mode change, session switch, or resolution change.
const DXGI_ERR_ACCESS_LOST: windows::core::HRESULT = windows::core::HRESULT(0x887A0026_u32 as i32);

/// Resources needed to run the DXGI capture thread.
struct CaptureResources {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    output_dup: IDXGIOutputDuplication,
    texture_pool: Arc<TexturePool>,
    display_id: u32,
    cap_width: u32,
    cap_height: u32,
    target_fps: f64,
    video_tx: mpsc::SyncSender<Frame>,
}

// SAFETY: COM pointers wrapped by the `windows` crate are reference-counted
// and safe to send across threads.  The `IDXGIOutputDuplication` will only
// be used by the single capture thread after the move.
#[allow(unsafe_code)]
unsafe impl Send for CaptureResources {}

/// Active DXGI Desktop Duplication capture stream.
pub struct WindowsStream {
    stop_flag: Arc<AtomicBool>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    resources: Mutex<Option<CaptureResources>>,
    start_time: Instant,
    video_rx: mpsc::Receiver<Frame>,
    capture_audio: bool,
}

impl WindowsStream {
    pub fn new(display: &Display, config: &CaptureConfig) -> Result<Self, CaptureError> {
        if config.capture_audio {
            return Err(CaptureError::Unsupported(
                "audio capture is not implemented on Windows",
            ));
        }
        if config.width.is_some_and(|width| width != display.width)
            || config.height.is_some_and(|height| height != display.height)
        {
            return Err(CaptureError::Unsupported(
                "DXGI capture does not resize frames",
            ));
        }
        let (video_tx, video_rx) = mpsc::sync_channel::<Frame>(3);

        // 1. Create a D3D11 device on the adapter that owns this display.
        let (device, context) = create_d3d11_device(display.id)?;

        // 2. Find the DXGI output matching this monitor.
        let (_output1, desc) = find_dxgi_output(&device, display.id)?;

        let cap_width = config.width.unwrap_or(
            (desc.DesktopCoordinates.right - desc.DesktopCoordinates.left).unsigned_abs(),
        );
        let cap_height = config.height.unwrap_or(
            (desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top).unsigned_abs(),
        );

        // 3. Create the output duplication (validates permissions early).
        let output_dup = create_duplication(&device, display.id)?;

        // 4. Pre-allocate a texture pool for GPU-to-GPU copies.
        let texture_pool = Arc::new(TexturePool::new());
        pre_allocate_pool(&device, &texture_pool, cap_width, cap_height);

        Ok(Self {
            stop_flag: Arc::new(AtomicBool::new(false)),
            thread: Mutex::new(None),
            resources: Mutex::new(Some(CaptureResources {
                device,
                context,
                output_dup,
                texture_pool,
                display_id: display.id,
                cap_width,
                cap_height,
                target_fps: config.fps,
                video_tx,
            })),
            start_time: Instant::now(),
            video_rx,
            capture_audio: config.capture_audio,
        })
    }

    pub fn start(&self) -> Result<(), CaptureError> {
        let res = self
            .resources
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
            .ok_or_else(|| CaptureError::Platform("capture already started or stopped".into()))?;

        let stop_flag = Arc::clone(&self.stop_flag);

        let handle = std::thread::Builder::new()
            .name("dxgi-capture".into())
            .spawn(move || {
                capture_loop(res, stop_flag);
            })
            .map_err(|e| CaptureError::Platform(format!("spawn capture thread: {e}")))?;

        *self
            .thread
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(handle);
        Ok(())
    }

    /// Poll for a single frame without spawning a capture thread.
    ///
    /// Returns `Ok(None)` when no new desktop content is available.
    /// Must not be used after [`start()`](Self::start).
    pub fn poll_frame(&self) -> Result<Option<Frame>, CaptureError> {
        let mut guard = self
            .resources
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let res = guard.as_mut().ok_or_else(|| {
            CaptureError::Platform(
                "resources unavailable (already started in threaded mode?)".into(),
            )
        })?;

        let frame_period_ms = ((1000.0 / res.target_fps).round() as u32).max(1);
        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;

        // SAFETY: Duplication is exclusively owned by this capture worker; the
        // output pointers point to initialized storage valid for this call.
        let result = unsafe {
            res.output_dup
                .AcquireNextFrame(frame_period_ms, &raw mut frame_info, &raw mut resource)
        };

        match result {
            Ok(()) => {
                let frame = if let Some(ref dxgi_res) = resource {
                    let timestamp_ns = self.start_time.elapsed().as_nanos() as u64;
                    make_frame_from_resource(
                        dxgi_res,
                        &res.device,
                        &res.context,
                        &res.texture_pool,
                        timestamp_ns,
                        res.cap_width,
                        res.cap_height,
                    )
                    .map(Some)
                } else {
                    Ok(None)
                };
                // SAFETY: A successful AcquireNextFrame above must be paired with release.
                unsafe {
                    let _ = res.output_dup.ReleaseFrame();
                }
                frame
            }
            Err(e) if e.code() == DXGI_ERR_WAIT_TIMEOUT => Ok(None),
            Err(e) if e.code() == DXGI_ERR_ACCESS_LOST => {
                tracing::warn!("DXGI access lost — recreating output duplication");
                std::thread::sleep(std::time::Duration::from_millis(200));
                match try_recreate_duplication(
                    &res.device,
                    res.display_id,
                    &mut res.cap_width,
                    &mut res.cap_height,
                    &mut res.texture_pool,
                ) {
                    Ok(dup) => {
                        res.output_dup = dup;
                    }
                    Err(e) => {
                        tracing::error!("failed to recreate output duplication: {e}");
                        std::thread::sleep(std::time::Duration::from_secs(1));
                    }
                }
                Ok(None)
            }
            Err(e) => Err(CaptureError::Platform(format!("AcquireNextFrame: {e}"))),
        }
    }

    pub fn stop(&self) -> Result<(), CaptureError> {
        self.stop_flag.store(true, Ordering::Release);
        if let Some(handle) = self
            .thread
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            handle
                .join()
                .map_err(|_| CaptureError::Platform("capture thread panicked".into()))?;
        }
        self.resources
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        Ok(())
    }

    pub fn next_frame(&self) -> Result<Frame, CaptureError> {
        self.video_rx.recv().map_err(|_| CaptureError::StreamEnded)
    }

    pub fn try_next_frame(&self) -> Result<Option<Frame>, CaptureError> {
        match self.video_rx.try_recv() {
            Ok(frame) => Ok(Some(frame)),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => Err(CaptureError::StreamEnded),
        }
    }

    pub fn next_frame_timeout(
        &self,
        timeout: std::time::Duration,
    ) -> Result<Option<Frame>, CaptureError> {
        match self.video_rx.recv_timeout(timeout) {
            Ok(frame) => Ok(Some(frame)),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(CaptureError::StreamEnded),
        }
    }

    pub fn next_audio_frame(&self) -> Result<AudioFrame, CaptureError> {
        Err(CaptureError::Unsupported(if self.capture_audio {
            "audio capture not implemented on windows backend"
        } else {
            "audio capture not enabled"
        }))
    }

    pub fn try_next_audio_frame(&self) -> Result<Option<AudioFrame>, CaptureError> {
        Err(CaptureError::Unsupported(if self.capture_audio {
            "audio capture not implemented on windows backend"
        } else {
            "audio capture not enabled"
        }))
    }

    #[must_use]
    pub fn has_audio(&self) -> bool {
        self.capture_audio
    }
}

impl Drop for WindowsStream {
    fn drop(&mut self) {
        // Best-effort cleanup — ignore errors since we're in a destructor.
        let _ = self.stop();
    }
}

// ── Capture thread ────────────────────────────────────────────────────

/// Main capture loop running on a dedicated thread.
fn capture_loop(res: CaptureResources, stop_flag: Arc<AtomicBool>) {
    let CaptureResources {
        device,
        context,
        mut output_dup,
        mut texture_pool,
        display_id,
        mut cap_width,
        mut cap_height,
        target_fps,
        video_tx,
    } = res;

    let start_time = Instant::now();

    let frame_period_ms = ((1000.0 / target_fps).round() as u32).max(1);

    // Persistent texture for idle repeat frames (allocated lazily).
    let mut last_desktop: Option<ID3D11Texture2D> = None;

    // Periodic repeats keep the stream alive during idle periods.
    let mut last_sent = Instant::now();
    let repeat_interval = std::time::Duration::from_millis(500);

    while !stop_flag.load(Ordering::Relaxed) {
        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;

        // SAFETY: Duplication is exclusively owned by this capture worker; the
        // output pointers point to initialized storage valid for this call.
        let result = unsafe {
            output_dup.AcquireNextFrame(frame_period_ms, &raw mut frame_info, &raw mut resource)
        };

        match result {
            Ok(()) => {
                if let Some(ref res) = resource {
                    let timestamp_ns = start_time.elapsed().as_nanos() as u64;
                    if let Ok(()) = process_frame(
                        res,
                        &device,
                        &context,
                        &video_tx,
                        &texture_pool,
                        timestamp_ns,
                        cap_width,
                        cap_height,
                    ) {
                        last_sent = Instant::now();
                    }

                    update_last_desktop(
                        res,
                        &device,
                        &context,
                        &mut last_desktop,
                        cap_width,
                        cap_height,
                    );
                }
                // SAFETY: A successful AcquireNextFrame above must be paired with release.
                unsafe {
                    let _ = output_dup.ReleaseFrame();
                }
            }
            Err(e) if e.code() == DXGI_ERR_WAIT_TIMEOUT => {
                if last_sent.elapsed() >= repeat_interval
                    && let Some(ld) = last_desktop.as_ref()
                {
                    let timestamp_ns = start_time.elapsed().as_nanos() as u64;
                    if let Ok(()) = send_frame_from_texture(
                        ld,
                        &device,
                        &context,
                        &video_tx,
                        &texture_pool,
                        timestamp_ns,
                        cap_width,
                        cap_height,
                    ) {
                        last_sent = Instant::now();
                    }
                }
            }
            Err(e) if e.code() == DXGI_ERR_ACCESS_LOST => {
                tracing::warn!("DXGI access lost — recreating output duplication");
                std::thread::sleep(std::time::Duration::from_millis(200));

                match try_recreate_duplication(
                    &device,
                    display_id,
                    &mut cap_width,
                    &mut cap_height,
                    &mut texture_pool,
                ) {
                    Ok(dup) => {
                        output_dup = dup;
                        last_desktop = None;
                    }
                    Err(e) => {
                        tracing::error!("failed to recreate output duplication: {e}");
                        std::thread::sleep(std::time::Duration::from_secs(1));
                    }
                }
                continue;
            }
            Err(e) => {
                tracing::error!("AcquireNextFrame failed: {e}");
                break;
            }
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────
