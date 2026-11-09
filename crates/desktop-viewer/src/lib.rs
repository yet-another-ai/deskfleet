//! Native desktop viewer. Network, decoding and presentation run independently.

#[cfg(any(target_os = "android", target_os = "ios"))]
mod android;
#[cfg(target_os = "android")]
mod android_decoder;
#[cfg(any(target_os = "macos", target_os = "ios", test))]
mod av1_config;
#[cfg(test)]
mod codec_tests;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod gpui_input;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod host;
#[cfg(any(target_os = "android", target_os = "ios"))]
mod input;
mod input_configuration;
mod input_queue;
mod input_reply;
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod macos_decoder;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod nsh_chrome;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod nsh_keyboard_focus;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod nsh_layout;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod nsh_session_state;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod nsh_toolbar;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod nsh_ui;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod nsh_video;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod nsh_window;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod physical_input;
mod protocol;
mod queue;
#[cfg(any(target_os = "android", target_os = "ios"))]
mod renderer;
#[cfg(any(
    target_os = "windows",
    target_os = "macos",
    target_os = "android",
    target_os = "ios",
    test
))]
mod rtp_video;
mod session;
mod session_manager;
#[cfg(target_os = "windows")]
mod windows_decoder;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
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
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        codec: protocol::Codec,
    },
    FrameReady,
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Error(String),
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Close,
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Ui(protocol::UiState),
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Connected(bool),
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    InputReady,
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    SessionEnded,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Clone)]
pub(crate) struct WindowNotifier(async_channel::Sender<WindowEvent>);

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl WindowNotifier {
    pub(crate) fn send_event(&self, event: WindowEvent) -> Result<(), Error> {
        self.0.try_send(event).map_err(|_| "viewer closed".into())
    }
}
#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) type WindowNotifier = android::AndroidNotifier;

/// Open the native viewer and consume its Electron-owned JSON-lines control pipe.
/// Must run on the process's main thread for native window event-loop ownership.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn run() -> Result<(), Error> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(io::stderr)
        .try_init();
    nsh_window::run()
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn run() -> Result<(), Error> {
    Err("standalone binary execution is not used on mobile".into())
}
