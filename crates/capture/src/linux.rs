//! Capture uses the same desktop backend selection as permissions and input.

use std::time::Duration;

use deskfleet_linux_desktop::{Backend, backend};

use crate::{AudioFrame, CaptureConfig, CaptureError, Display, Frame};

mod wayland;
mod x11;

pub(crate) fn displays() -> Result<Vec<Display>, CaptureError> {
    match backend() {
        Backend::Wayland => wayland::displays(),
        Backend::X11 => x11::displays(),
        Backend::Unavailable => Err(CaptureError::Unsupported("no Linux desktop session")),
    }
}

pub(crate) enum LinuxStream {
    Wayland(wayland::WaylandStream),
    X11(x11::X11Stream),
}

impl LinuxStream {
    pub(crate) fn new(display: &Display, config: &CaptureConfig) -> Result<Self, CaptureError> {
        match backend() {
            Backend::Wayland => wayland::WaylandStream::new(display, config).map(Self::Wayland),
            Backend::X11 => x11::X11Stream::new(display, config).map(Self::X11),
            Backend::Unavailable => Err(CaptureError::Unsupported("no Linux desktop session")),
        }
    }

    pub(crate) fn start(&self) -> Result<(), CaptureError> {
        match self {
            Self::Wayland(stream) => stream.start(),
            Self::X11(stream) => stream.start(),
        }
    }

    pub(crate) fn stop(&self) -> Result<(), CaptureError> {
        match self {
            Self::Wayland(stream) => stream.stop(),
            Self::X11(stream) => stream.stop(),
        }
    }

    pub(crate) fn poll_frame(&self) -> Result<Option<Frame>, CaptureError> {
        match self {
            Self::Wayland(stream) => stream.poll_frame(),
            Self::X11(stream) => stream.poll_frame(),
        }
    }

    pub(crate) fn next_frame(&self) -> Result<Frame, CaptureError> {
        match self {
            Self::Wayland(stream) => stream.next_frame(),
            Self::X11(stream) => stream.next_frame(),
        }
    }

    pub(crate) fn try_next_frame(&self) -> Result<Option<Frame>, CaptureError> {
        self.next_frame_timeout(Duration::ZERO)
    }

    pub(crate) fn next_frame_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Option<Frame>, CaptureError> {
        match self {
            Self::Wayland(stream) => stream.next_frame_timeout(timeout),
            Self::X11(stream) => stream.next_frame_timeout(timeout),
        }
    }

    pub(crate) fn next_audio_frame(&self) -> Result<AudioFrame, CaptureError> {
        Err(CaptureError::Unsupported("Linux system audio capture"))
    }

    pub(crate) fn try_next_audio_frame(&self) -> Result<Option<AudioFrame>, CaptureError> {
        Err(CaptureError::Unsupported("Linux system audio capture"))
    }

    pub(crate) fn has_audio(&self) -> bool {
        false
    }
}
