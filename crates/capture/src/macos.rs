//! macOS screen capture backend using `ScreenCaptureKit`.

#![allow(unsafe_code, non_snake_case)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{AnyThread, DefinedClass, Message, define_class, msg_send};
use objc2_core_graphics::{CGDisplayCopyDisplayMode, CGDisplayMode, kCGColorSpaceSRGB};
use objc2_core_media::{CMSampleBuffer, CMTime, CMTimeFlags};
use objc2_core_video::{
    CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight, CVPixelBufferGetIOSurface,
    CVPixelBufferGetWidth,
};
use objc2_foundation::{NSArray, NSError, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamOutput, SCStreamOutputType, SCWindow,
};

use crate::audio::AudioFrame;
use crate::error::CaptureError;
use crate::frame::{Frame, PixelFormat};
use crate::latest_frame::LatestFrame;
use crate::surface::NativeSurface;
use crate::types::{CaptureConfig, Display};

#[path = "macos_audio.rs"]
mod audio_capture;
use audio_capture::audio_from_sample_buffer;

/// One replaceable raw frame; callbacks never retain an old desktop backlog.
type SharedVideo = Arc<LatestFrame<Frame>>;

/// Shared, closable sender handle for audio frames.
type SharedAudioSender = Arc<Mutex<Option<mpsc::SyncSender<AudioFrame>>>>;

/// List available displays by synchronously querying `SCShareableContent`.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn displays() -> Result<Vec<Display>, CaptureError> {
    let (tx, rx) = mpsc::channel::<Result<Vec<Display>, CaptureError>>();

    let handler = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            if !error.is_null() {
                // SAFETY: ScreenCaptureKit supplies a valid NSError for this callback.
                let msg = unsafe { &*error }.localizedDescription().to_string();
                let _ = tx.send(Err(CaptureError::Platform(msg)));
                return;
            }
            if content.is_null() {
                let _ = tx.send(Err(CaptureError::NoDisplays));
                return;
            }
            // SAFETY: Non-null callback content is valid until the callback returns.
            let content = unsafe { &*content };
            // SAFETY: The content is a live ScreenCaptureKit object.
            let sc_displays: Retained<NSArray<SCDisplay>> = unsafe { content.displays() };
            let mut result = Vec::new();
            for d in &sc_displays {
                // SAFETY: The retained content array owns this SCDisplay.
                let id = unsafe { d.displayID() };
                // SAFETY: SCDisplay width and height are immutable getters.
                let (width, height) = unsafe { (d.width(), d.height()) };
                let refresh_rate_hz = CGDisplayCopyDisplayMode(id)
                    .map_or(0.0, |mode| CGDisplayMode::refresh_rate(Some(&mode)));
                result.push(Display {
                    id,
                    name: None,
                    display_number: None,
                    width: width as u32,
                    height: height as u32,
                    refresh_rate_hz,
                });
            }
            let _ = tx.send(Ok(result));
        },
    );

    // SAFETY: ScreenCaptureKit copies the completion block for asynchronous use.
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            true,
            true,
            &handler,
        );
    }

    rx.recv()
        .map_err(|_| CaptureError::Platform("content query channel dropped".into()))?
}

struct OutputDelegateIvars {
    video: SharedVideo,
    audio_tx: SharedAudioSender,
    audio_sample_rate: u32,
    audio_channels: u16,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; we don't implement Drop.
    #[unsafe(super(objc2_foundation::NSObject))]
    #[ivars = OutputDelegateIvars]
    #[name = "DFCaptureOutputDelegate"]
    #[allow(non_snake_case)]
    struct OutputDelegate;

    // SAFETY: OutputDelegate is an NSObject subclass with no custom deallocation.
    unsafe impl NSObjectProtocol for OutputDelegate {}

    // SAFETY: The declared method signature matches SCStreamOutput exactly.
    unsafe impl SCStreamOutput for OutputDelegate {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn stream_didOutputSampleBuffer_ofType(
            &self,
            _stream: &SCStream,
            sample_buffer: &CMSampleBuffer,
            output_type: SCStreamOutputType,
        ) {
            if output_type == SCStreamOutputType::Screen {
                if let Some(frame) = frame_from_sample_buffer(sample_buffer) {
                    self.ivars().video.publish(frame);
                }
            } else if output_type == SCStreamOutputType::Audio {
                let ivars = self.ivars();
                if let Some(audio) = audio_from_sample_buffer(
                    sample_buffer,
                    ivars.audio_sample_rate,
                    ivars.audio_channels,
                ) && let Ok(guard) = ivars.audio_tx.lock()
                    && let Some(tx) = guard.as_ref()
                {
                    let _ = tx.try_send(audio);
                }
            }
        }
    }

    // SAFETY: The declared method signature matches SCStreamDelegate exactly.
    unsafe impl SCStreamDelegate for OutputDelegate {
        #[unsafe(method(stream:didStopWithError:))]
        unsafe fn stream_didStopWithError(&self, _stream: &SCStream, _error: &NSError) {
            // Close capture delivery so consumers observe StreamEnded after an OS failure.
            self.ivars().video.close();
            if let Ok(mut sender) = self.ivars().audio_tx.lock() {
                *sender = None;
            }
        }
    }
);

impl OutputDelegate {
    fn new(
        video: SharedVideo,
        audio_tx: SharedAudioSender,
        audio_sample_rate: u32,
        audio_channels: u16,
    ) -> Retained<Self> {
        let this = Self::alloc().set_ivars(OutputDelegateIvars {
            video,
            audio_tx,
            audio_sample_rate,
            audio_channels,
        });
        // SAFETY: NSObject init initializes this allocated NSObject subclass.
        unsafe { msg_send![super(this), init] }
    }
}

/// Extract a [`Frame`] from a `CMSampleBuffer` via its backing `IOSurface`.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn frame_from_sample_buffer(sample_buffer: &CMSampleBuffer) -> Option<Frame> {
    // SAFETY: ScreenCaptureKit supplies a valid sample buffer for this callback.
    let pixel_buffer = unsafe { sample_buffer.image_buffer()? };

    // SAFETY: The retained pixel buffer is BGRA as configured on SCStream.
    unsafe {
        let io_surface = CVPixelBufferGetIOSurface(Some(&*pixel_buffer))?;

        let width = CVPixelBufferGetWidth(&pixel_buffer);
        let height = CVPixelBufferGetHeight(&pixel_buffer);
        let stride = CVPixelBufferGetBytesPerRow(&pixel_buffer);

        let pts: CMTime = sample_buffer.presentation_time_stamp();
        let timestamp_ns = timestamp_ns(pts);

        let surface = NativeSurface {
            inner: crate::surface::macos::PlatformInner {
                surface: io_surface,
                pixel_buffer,
            },
        };

        Some(Frame::new(
            width as u32,
            height as u32,
            stride as u32,
            PixelFormat::Bgra8,
            timestamp_ns,
            surface,
        ))
    }
}

/// macOS capture stream backed by `SCStream`.
pub struct MacOSStream {
    stream: Retained<SCStream>,
    _delegate: Retained<OutputDelegate>,
    video: SharedVideo,
    audio_tx_handle: SharedAudioSender,
    audio_rx: Option<mpsc::Receiver<AudioFrame>>,
    started: AtomicBool,
    fps: f64,
}

// SAFETY: SCStream is thread-safe (reference-counted, documented for use from any thread).
#[allow(clippy::non_send_fields_in_send_ty)]
unsafe impl Send for MacOSStream {}

impl MacOSStream {
    #[allow(clippy::cast_possible_truncation)]
    pub fn new(display: &Display, config: &CaptureConfig) -> Result<Self, CaptureError> {
        let sc_display = find_sc_display(display.id)?;
        let (audio_tx, audio_rx) = if config.capture_audio {
            let (tx, rx) = mpsc::sync_channel::<AudioFrame>(8);
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };

        let empty_windows: Retained<NSArray<SCWindow>> = NSArray::new();
        // SAFETY: The display and exclusions are live retained objects.
        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                &sc_display,
                &empty_windows,
            )
        };

        // SAFETY: Configuration is exclusively owned until passed to SCStream;
        // dimensions, FPS and audio format were validated before backend creation.
        let sc_config = unsafe {
            let c = SCStreamConfiguration::new();
            let width = config.width.unwrap_or(display.width) as usize;
            let height = config.height.unwrap_or(display.height) as usize;
            c.setWidth(width);
            c.setHeight(height);
            // Preserve fractional FPS (e.g. 59.94) with a high-resolution
            // CMTime instead of truncating to integer timescales.
            const CM_TIME_TIMESCALE: i32 = 1_000_000;
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let frame_interval_value =
                ((f64::from(CM_TIME_TIMESCALE)) / config.fps.max(1.0)).round() as i64;
            c.setMinimumFrameInterval(CMTime {
                value: frame_interval_value.max(1),
                timescale: CM_TIME_TIMESCALE,
                flags: CMTimeFlags::Valid,
                epoch: 0,
            });
            c.setShowsCursor(config.show_cursor);
            c.setPixelFormat(0x4247_5241); // kCVPixelFormatType_32BGRA
            c.setColorSpaceName(kCGColorSpaceSRGB);

            // Enable audio capture if requested.
            if config.capture_audio {
                c.setCapturesAudio(true);
                #[allow(clippy::cast_possible_wrap)]
                c.setSampleRate(config.audio_sample_rate as isize);
                #[allow(clippy::cast_possible_wrap)]
                c.setChannelCount(config.audio_channels as isize);
                c.setExcludesCurrentProcessAudio(true);
            }

            c
        };

        // Video retains only the newest surface; audio keeps its bounded channel.
        #[allow(clippy::arc_with_non_send_sync)]
        let video: SharedVideo = Arc::new(LatestFrame::new());
        #[allow(clippy::arc_with_non_send_sync)]
        let audio_tx_handle: SharedAudioSender = Arc::new(Mutex::new(audio_tx));

        let delegate = OutputDelegate::new(
            Arc::clone(&video),
            Arc::clone(&audio_tx_handle),
            config.audio_sample_rate,
            config.audio_channels,
        );

        // SAFETY: All arguments are retained for construction and SCStream retains
        // the configuration and delegate as required by its initializer.
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &sc_config,
                Some(ProtocolObject::from_ref(&*delegate)),
            )
        };

        let queue = DispatchQueue::new("com.deskfleet.capture", None);
        // SAFETY: The stream/delegate and queue are live; SCStream retains the output.
        unsafe {
            // Register for screen (video) output.
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(
                    ProtocolObject::from_ref(&*delegate),
                    SCStreamOutputType::Screen,
                    Some(&queue),
                )
                .map_err(|e| CaptureError::Platform(e.localizedDescription().to_string()))?;

            // Register for audio output if enabled.
            if config.capture_audio {
                stream
                    .addStreamOutput_type_sampleHandlerQueue_error(
                        ProtocolObject::from_ref(&*delegate),
                        SCStreamOutputType::Audio,
                        Some(&queue),
                    )
                    .map_err(|e| CaptureError::Platform(e.localizedDescription().to_string()))?;
            }
        }

        Ok(Self {
            stream,
            _delegate: delegate,
            video,
            audio_tx_handle,
            audio_rx,
            started: AtomicBool::new(false),
            fps: config.fps,
        })
    }

    /// Returns the configured capture frame rate.
    pub fn fps(&self) -> f64 {
        self.fps
    }

    /// Start the capture stream if not already started (idempotent).
    ///
    /// This is used by the `poll_frame()` path so that the caller does
    /// not need to call [`start()`](Self::start) explicitly.
    pub fn ensure_started(&self) -> Result<(), CaptureError> {
        if self
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .is_ok()
            && let Err(e) = self.start_inner()
        {
            self.started.store(false, Ordering::Release);
            return Err(e);
        }
        Ok(())
    }

    /// Start capture.
    pub fn start(&self) -> Result<(), CaptureError> {
        if self
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .is_err()
        {
            return Ok(());
        }
        if let Err(e) = self.start_inner() {
            self.started.store(false, Ordering::Release);
            return Err(e);
        }
        Ok(())
    }

    fn start_inner(&self) -> Result<(), CaptureError> {
        let (tx, rx) = mpsc::channel::<Result<(), CaptureError>>();

        let handler = RcBlock::new(move |error: *mut NSError| {
            if error.is_null() {
                let _ = tx.send(Ok(()));
            } else {
                // SAFETY: ScreenCaptureKit supplies a valid NSError for this callback.
                let msg = unsafe { &*error }.localizedDescription().to_string();
                let _ = tx.send(Err(CaptureError::Platform(msg)));
            }
        });

        // SAFETY: SCStream is retained and copies the completion block.
        unsafe {
            self.stream
                .startCaptureWithCompletionHandler(Some(&handler));
        }

        rx.recv()
            .map_err(|_| CaptureError::Platform("start capture channel dropped".into()))?
    }

    /// Poll for a single frame from `ScreenCaptureKit`.
    ///
    /// Starts capture automatically on first call.
    pub fn poll_frame(&self) -> Result<Option<Frame>, CaptureError> {
        self.ensure_started()?;
        let timeout = Duration::from_secs_f64((1.0 / self.fps()).max(0.001));
        self.video.receive(Some(timeout))
    }

    pub fn next_frame(&self) -> Result<Frame, CaptureError> {
        self.video.receive(None)?.ok_or(CaptureError::StreamEnded)
    }

    pub fn try_next_frame(&self) -> Result<Option<Frame>, CaptureError> {
        self.video.receive(Some(Duration::ZERO))
    }

    pub fn next_frame_timeout(&self, timeout: Duration) -> Result<Option<Frame>, CaptureError> {
        self.video.receive(Some(timeout))
    }

    pub fn next_audio_frame(&self) -> Result<AudioFrame, CaptureError> {
        let rx = self
            .audio_rx
            .as_ref()
            .ok_or(CaptureError::Unsupported("audio capture not enabled"))?;
        rx.recv().map_err(|_| CaptureError::StreamEnded)
    }

    pub fn try_next_audio_frame(&self) -> Result<Option<AudioFrame>, CaptureError> {
        let rx = self
            .audio_rx
            .as_ref()
            .ok_or(CaptureError::Unsupported("audio capture not enabled"))?;
        match rx.try_recv() {
            Ok(frame) => Ok(Some(frame)),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => Err(CaptureError::StreamEnded),
        }
    }

    #[must_use]
    pub fn has_audio(&self) -> bool {
        self.audio_rx.is_some()
    }

    /// Stop capture.
    ///
    /// Closing delivery wakes blocked readers with `StreamEnded` once the last
    /// pending frame has been consumed.
    pub fn stop(&self) -> Result<(), CaptureError> {
        if !self.started.swap(false, Ordering::AcqRel) {
            return Ok(());
        }
        let (tx, rx) = mpsc::channel::<Result<(), CaptureError>>();

        let handler = RcBlock::new(move |error: *mut NSError| {
            if error.is_null() {
                let _ = tx.send(Ok(()));
            } else {
                // SAFETY: ScreenCaptureKit supplies a valid NSError for this callback.
                let msg = unsafe { &*error }.localizedDescription().to_string();
                let _ = tx.send(Err(CaptureError::Platform(msg)));
            }
        });

        // SAFETY: SCStream is retained and copies the completion block.
        unsafe {
            self.stream.stopCaptureWithCompletionHandler(Some(&handler));
        }

        let result = rx
            .recv()
            .map_err(|_| CaptureError::Platform("stop capture channel dropped".into()))?;

        // Close delivery and wake blocked video/audio readers.
        self.video.close();
        if let Ok(mut guard) = self.audio_tx_handle.lock() {
            *guard = None;
        }

        result
    }
}

/// Find the `SCDisplay` matching the given display ID.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn find_sc_display(display_id: u32) -> Result<Retained<SCDisplay>, CaptureError> {
    let (tx, rx) = mpsc::channel();

    let handler = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            if !error.is_null() {
                // SAFETY: ScreenCaptureKit supplies a valid NSError for this callback.
                let msg = unsafe { &*error }.localizedDescription().to_string();
                let _ = tx.send(Err(CaptureError::Platform(msg)));
                return;
            }
            if content.is_null() {
                let _ = tx.send(Err(CaptureError::NoDisplays));
                return;
            }
            // SAFETY: Non-null callback content is valid until the callback returns.
            let content = unsafe { &*content };
            // SAFETY: The content is a live ScreenCaptureKit object.
            let sc_displays: Retained<NSArray<SCDisplay>> = unsafe { content.displays() };
            for d in &sc_displays {
                // SAFETY: The retained content array owns this SCDisplay.
                let id = unsafe { d.displayID() };
                if id == display_id {
                    let _ = tx.send(Ok(d.retain()));
                    return;
                }
            }
            let _ = tx.send(Err(CaptureError::Platform(format!(
                "display {display_id} not found"
            ))));
        },
    );

    // SAFETY: ScreenCaptureKit copies the completion block for asynchronous use.
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            true,
            true,
            &handler,
        );
    }

    rx.recv()
        .map_err(|_| CaptureError::Platform("display query channel dropped".into()))?
}

impl Drop for MacOSStream {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            tracing::warn!(%error, "failed to stop capture during drop");
        }
    }
}

fn timestamp_ns(time: CMTime) -> u64 {
    if !time.flags.contains(CMTimeFlags::Valid) || time.value < 0 || time.timescale <= 0 {
        return 0;
    }
    // Convert before narrowing; multiplying a nanosecond timebase in u64 would
    // wrap after approximately 18 seconds of capture.
    let ns = i128::from(time.value) * 1_000_000_000 / i128::from(time.timescale);
    u64::try_from(ns).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod timestamp_tests {
    use super::*;

    #[test]
    fn nanosecond_timebase_does_not_wrap_after_seconds() {
        let time = CMTime {
            value: 60_000_000_000,
            timescale: 1_000_000_000,
            flags: CMTimeFlags::Valid,
            epoch: 0,
        };
        assert_eq!(timestamp_ns(time), 60_000_000_000);
    }
}
