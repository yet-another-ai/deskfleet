//! Native desktop viewer. Network, decoding and presentation run independently.

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
mod android_decoder;
#[cfg(any(target_os = "macos", test))]
mod av1_config;
#[cfg(test)]
mod codec_tests;
#[cfg(not(target_os = "android"))]
mod gpui_input;
#[cfg(not(target_os = "android"))]
mod host;
#[cfg(target_os = "android")]
mod input;
mod input_configuration;
mod input_queue;
mod input_reply;
#[cfg(target_os = "macos")]
mod macos_decoder;
#[cfg(not(target_os = "android"))]
mod nsh_chrome;
#[cfg(not(target_os = "android"))]
mod nsh_layout;
#[cfg(not(target_os = "android"))]
mod nsh_toolbar;
#[cfg(not(target_os = "android"))]
mod nsh_ui;
#[cfg(not(target_os = "android"))]
mod nsh_video;
#[cfg(not(target_os = "android"))]
mod nsh_window;
#[cfg(not(target_os = "android"))]
mod physical_input;
mod protocol;
mod queue;
#[cfg(target_os = "android")]
mod renderer;
#[cfg(any(
    target_os = "windows",
    target_os = "macos",
    target_os = "android",
    test
))]
mod rtp_video;
mod session;
mod session_manager;
#[cfg(target_os = "windows")]
mod windows_decoder;

#[cfg(not(target_os = "android"))]
use std::io;
use std::time::Instant;

type Error = Box<dyn std::error::Error + Send + Sync>;

struct Frame {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    ready_at: Instant,
}

enum WindowEvent {
    Start {
        title: String,
        control: bool,
        codec: protocol::Codec,
    },
    FrameReady,
    Error(String),
    #[cfg(not(target_os = "android"))]
    Close,
    #[cfg(not(target_os = "android"))]
    Ui(protocol::UiState),
    #[cfg(not(target_os = "android"))]
    Connected(bool),
    #[cfg(not(target_os = "android"))]
    InputReady,
    #[cfg(not(target_os = "android"))]
    SessionEnded,
}

#[cfg(not(target_os = "android"))]
#[derive(Clone)]
pub(crate) struct WindowNotifier(async_channel::Sender<WindowEvent>);

#[cfg(not(target_os = "android"))]
impl WindowNotifier {
    pub(crate) fn send_event(&self, event: WindowEvent) -> Result<(), Error> {
        self.0.try_send(event).map_err(|_| "viewer closed".into())
    }
}
#[cfg(target_os = "android")]
pub(crate) type WindowNotifier = android::AndroidNotifier;

/// Open the native viewer and consume its Electron-owned JSON-lines control pipe.
/// Must run on the process's main thread for native window event-loop ownership.
#[cfg(not(target_os = "android"))]
pub fn run() -> Result<(), Error> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(io::stderr)
        .try_init();
    nsh_window::run()
}

#[cfg(target_os = "android")]
pub fn run() -> Result<(), Error> {
    Err("standalone binary execution is not used on Android".into())
}
