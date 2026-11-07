//! Native desktop viewer. Network, decoding and presentation run independently.

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
mod android_decoder;
#[cfg(any(target_os = "macos", test))]
mod av1_config;
#[cfg(test)]
mod codec_tests;
mod input;
mod input_queue;
mod input_reply;
#[cfg(target_os = "macos")]
mod macos_decoder;
#[cfg(not(target_os = "android"))]
mod presentation;
mod protocol;
mod queue;
mod renderer;
#[cfg(any(
    target_os = "windows",
    target_os = "macos",
    target_os = "android",
    test
))]
mod rtp_video;
mod session;
#[cfg(not(target_os = "android"))]
mod window;
#[cfg(target_os = "windows")]
mod windows_decoder;

#[cfg(not(target_os = "android"))]
use std::io::{self, BufRead};
#[cfg(not(target_os = "android"))]
use std::sync::{Arc, Mutex};
#[cfg(not(target_os = "android"))]
use std::time::Duration;
use std::time::Instant;

#[cfg(not(target_os = "android"))]
use serde_json::json;
#[cfg(not(target_os = "android"))]
use tokio::sync::{mpsc, watch};
#[cfg(not(target_os = "android"))]
use winit::event_loop::{EventLoop, EventLoopProxy};

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
    },
    FrameReady,
    Error(String),
    #[cfg(not(target_os = "android"))]
    Close,
}

#[cfg(not(target_os = "android"))]
pub(crate) type WindowNotifier = EventLoopProxy<WindowEvent>;
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
    let mut event_loop = EventLoop::<WindowEvent>::with_user_event();
    #[cfg(target_os = "macos")]
    {
        use winit::platform::macos::EventLoopBuilderExtMacOS;
        // AppKit's default menu consumes Command-Q/H before the remote input
        // handler can forward them. The native close button still closes us.
        event_loop.with_default_menu(false);
    }
    let event_loop = event_loop.build()?;
    let proxy = event_loop.create_proxy();
    let frames = Arc::new(Mutex::new(queue::FrameQueue::default()));
    let (commands_tx, commands) = mpsc::channel(32);
    let (input, inputs) = input_queue::channel();
    let (shutdown, shutdown_rx) = watch::channel(false);
    let reader_proxy = proxy.clone();
    std::thread::Builder::new()
        .name("viewer control".into())
        .spawn(move || {
            for line in io::stdin().lock().lines() {
                let parsed = line.map_err(|error| error.to_string()).and_then(|line| {
                    serde_json::from_str(&line).map_err(|error| error.to_string())
                });
                match parsed {
                    Ok(command) => {
                        if commands_tx.blocking_send(command).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = reader_proxy.send_event(WindowEvent::Error(error));
                        return;
                    }
                }
            }
            let _ = reader_proxy.send_event(WindowEvent::Close);
        })?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let session_frames = Arc::clone(&frames);
    let session = runtime.spawn(async move {
        let result =
            session::run(commands, inputs, session_frames, proxy.clone(), shutdown_rx).await;
        match &result {
            Ok(()) => {
                let _ = proxy.send_event(WindowEvent::Close);
            }
            Err(error) => {
                let _ = proxy.send_event(WindowEvent::Error(error.to_string()));
            }
        }
        result
    });
    let mut viewer = window::Viewer::new(frames, input, shutdown.clone());
    let window_result = event_loop.run_app(&mut viewer);
    shutdown.send_replace(true);
    let session_result = runtime.block_on(session);
    // The detached stdin reader is an ordinary thread, never a Tokio blocking
    // task that could keep runtime shutdown alive after the native window closes.
    runtime.shutdown_timeout(Duration::from_secs(2));
    protocol::emit(json!({"type":"closed"}))?;
    window_result?;
    session_result??;
    if let Some(error) = viewer.error {
        return Err(error.into());
    }
    Ok(())
}

#[cfg(target_os = "android")]
pub fn run() -> Result<(), Error> {
    Err("standalone binary execution is not used on Android".into())
}
