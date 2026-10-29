use std::os::fd::AsFd;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::xfixes::ConnectionExt as _;
use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, VisualClass};
use x11rb::rust_connection::RustConnection;

use crate::{Error, Result, Source, display, pixels, platform};

#[derive(Debug)]
pub struct VideoFrame {
    pub width: u32,
    pub height: u32,
    pub timestamp_ns: u64,
    pub pixels: Vec<u8>,
}

#[derive(Default)]
struct State {
    latest: Option<VideoFrame>,
    error: Option<Error>,
    stopped: bool,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

/// A producer owns the X connection and replaces one queued frame. Blocking X
/// requests never run in the bounded/zero-timeout consumer poll.
pub struct Capture {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
    socket: socket2::Socket,
}

impl Capture {
    /// Check stream state without consuming the pending frame.
    pub fn start(&self) -> Result<()> {
        let state = self
            .shared
            .state
            .lock()
            .map_err(|error| platform(error.to_string()))?;
        if state.stopped {
            return Err(Error::Stopped);
        }
        state.error.clone().map_or(Ok(()), Err)
    }

    pub fn new(source_id: u32, fps: f64, show_cursor: bool) -> Result<Self> {
        if !fps.is_finite() || !(1.0..=1000.0).contains(&fps) {
            return Err(Error::Unavailable("invalid X11 capture frame rate".into()));
        }
        let (connection, deadline) = display::connect_with_deadline()?;
        let source = deadline.finish(display::select(&connection, source_id))?;
        let format = deadline.finish(prepare(&connection, &source, show_cursor))?;
        drop(deadline);
        let shared = Arc::new(Shared::default());
        let socket = socket2::Socket::from(
            connection
                .stream()
                .as_fd()
                .try_clone_to_owned()
                .map_err(platform)?,
        );
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("deskfleet-x11-capture".into())
            .spawn(move || {
                let result = produce(
                    &connection,
                    &source,
                    format,
                    show_cursor,
                    fps,
                    &worker_shared,
                );
                if let Err(error) = result {
                    let mut state = worker_shared
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    state.latest = None;
                    state.error = Some(error);
                    worker_shared.changed.notify_all();
                }
            })
            .map_err(platform)?;
        Ok(Self {
            shared,
            worker: Mutex::new(Some(worker)),
            socket,
        })
    }

    pub fn next_frame(&self, timeout: Duration) -> Result<Option<VideoFrame>> {
        let state = self
            .shared
            .state
            .lock()
            .map_err(|error| platform(error.to_string()))?;
        let (mut state, _) = self
            .shared
            .changed
            .wait_timeout_while(state, timeout, |state| {
                !state.stopped && state.error.is_none() && state.latest.is_none()
            })
            .map_err(|error| platform(error.to_string()))?;
        if state.stopped {
            return Err(Error::Stopped);
        }
        if let Some(error) = &state.error {
            return Err(error.clone());
        }
        Ok(state.latest.take())
    }

    pub fn stop(&self) -> Result<()> {
        {
            let mut state = self
                .shared
                .state
                .lock()
                .map_err(|error| platform(error.to_string()))?;
            state.stopped = true;
            state.latest = None;
            self.shared.changed.notify_all();
        }
        // Wake a producer waiting for an X reply before joining it. The clone
        // shares the transport, so shutdown also interrupts its original fd.
        let _ = self.socket.shutdown(std::net::Shutdown::Both);
        if let Some(worker) = self
            .worker
            .lock()
            .map_err(|error| platform(error.to_string()))?
            .take()
        {
            worker
                .join()
                .map_err(|_| Error::Platform("X11 capture worker panicked".into()))?;
        }
        Ok(())
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            tracing::warn!(%error, "X11 capture cleanup failed");
        }
    }
}

fn produce(
    connection: &RustConnection,
    source: &Source,
    format: pixels::Format,
    show_cursor: bool,
    fps: f64,
    shared: &Shared,
) -> Result<()> {
    let start = Instant::now();
    let period = Duration::from_secs_f64(1.0 / fps);
    loop {
        let frame_start = Instant::now();
        if shared
            .state
            .lock()
            .map_err(|error| platform(error.to_string()))?
            .stopped
        {
            return Ok(());
        }
        display::check_changes(connection, source)?;
        let image = connection
            .get_image(
                ImageFormat::Z_PIXMAP,
                source.root,
                source.x,
                source.y,
                source.width as u16,
                source.height as u16,
                u32::MAX,
            )
            .map_err(platform)?
            .reply()
            .map_err(platform)?;
        let mut pixels = pixels::bgra(&image.data, source.width, source.height, format)?;
        if show_cursor {
            // QueryPointer identifies the cursor's root on multi-X-screen setups;
            // XFixes coordinates alone would otherwise overlay the wrong root.
            let pointer = connection
                .query_pointer(source.root)
                .map_err(platform)?
                .reply()
                .map_err(platform)?;
            if pointer.same_screen {
                let cursor = connection
                    .xfixes_get_cursor_image()
                    .map_err(platform)?
                    .reply()
                    .map_err(platform)?;
                pixels::cursor(
                    &mut pixels,
                    source.width,
                    source.height,
                    (source.x, source.y),
                    &cursor,
                );
            }
        }
        display::check_changes(connection, source)?;
        let mut state = shared
            .state
            .lock()
            .map_err(|error| platform(error.to_string()))?;
        if state.stopped {
            return Ok(());
        }
        state.latest = Some(VideoFrame {
            width: source.width,
            height: source.height,
            timestamp_ns: start.elapsed().as_nanos().try_into().unwrap_or(u64::MAX),
            pixels,
        });
        shared.changed.notify_all();
        let (state, _) = shared
            .changed
            .wait_timeout_while(
                state,
                period.saturating_sub(frame_start.elapsed()),
                |state| !state.stopped,
            )
            .map_err(|error| platform(error.to_string()))?;
        if state.stopped {
            return Ok(());
        }
    }
}

/// Shared prerequisites for default capture and read-only capability probing.
pub(crate) fn prepare(
    connection: &RustConnection,
    source: &Source,
    show_cursor: bool,
) -> Result<pixels::Format> {
    let screen = connection
        .setup()
        .roots
        .iter()
        .find(|screen| screen.root == source.root)
        .ok_or(Error::StaleSource)?;
    let visual = screen
        .allowed_depths
        .iter()
        .flat_map(|depth| &depth.visuals)
        .find(|visual| visual.visual_id == screen.root_visual)
        .ok_or_else(|| Error::Unavailable("X11 root visual is missing".into()))?;
    if visual.class != VisualClass::TRUE_COLOR {
        return Err(Error::Unavailable(
            "X11 capture requires a TrueColor root visual".into(),
        ));
    }
    let format = connection
        .setup()
        .pixmap_formats
        .iter()
        .find(|format| format.depth == screen.root_depth)
        .ok_or_else(|| Error::Unavailable("X11 root pixel format is missing".into()))?;
    let format = pixels::Format {
        bits: format.bits_per_pixel,
        scanline_pad: format.scanline_pad,
        order: connection.setup().image_byte_order,
        red: visual.red_mask,
        green: visual.green_mask,
        blue: visual.blue_mask,
    };
    if show_cursor {
        connection
            .xfixes_query_version(2, 0)
            .map_err(platform)?
            .reply()
            .map_err(platform)?;
    }
    if !matches!(format.bits, 16 | 24 | 32) || !matches!(format.scanline_pad, 8 | 16 | 32) {
        return Err(Error::Unavailable("unsupported X11 pixel layout".into()));
    }
    Ok(format)
}
