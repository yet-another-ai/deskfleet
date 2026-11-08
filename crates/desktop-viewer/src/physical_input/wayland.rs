//! A second keyboard resource on GPUI's existing Wayland connection.
//!
//! The private queue never replaces GPUI's listeners or commits its surface.

use std::collections::HashMap;
use std::io;
use std::os::fd::AsFd;
use std::os::unix::fs::FileExt;
use std::os::unix::net::UnixStream;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use deskfleet_input::NativeKeyCode;
use nix::errno::Errno;
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle};
use wayland_backend::client::{Backend, ObjectId, WaylandError};
use wayland_client::{
    Connection, Dispatch, EventQueue, Proxy, QueueHandle, WEnum,
    protocol::{wl_keyboard, wl_registry, wl_seat, wl_surface},
};
use xkbcommon::xkb;

use super::Bridge;
use crate::Error;

pub(super) struct Adapter {
    shutdown: UnixStream,
    worker: Option<JoinHandle<()>>,
}

impl Adapter {
    pub(super) fn new(window: &gpui::Window, bridge: Bridge) -> Result<Self, Error> {
        let RawDisplayHandle::Wayland(display) = window.display_handle()?.as_raw() else {
            return Err("Wayland keyboard requires a Wayland display".into());
        };
        let RawWindowHandle::Wayland(handle) = HasWindowHandle::window_handle(window)?.as_raw()
        else {
            return Err("Wayland keyboard requires a Wayland surface".into());
        };
        // SAFETY: The viewer drops this adapter and joins its worker before
        // closing the GPUI window. The foreign backend does not own wl_display.
        #[allow(unsafe_code)]
        let backend = unsafe { Backend::from_foreign_display(display.display.as_ptr().cast()) };
        let connection = Connection::from_backend(backend);
        // SAFETY: GPUI supplied a live wl_surface. Register only its identity;
        // never destroy it or install a listener on the borrowed proxy.
        #[allow(unsafe_code)]
        let id = unsafe {
            ObjectId::from_ptr(
                wl_surface::WlSurface::interface(),
                handle.surface.as_ptr().cast(),
            )
        }?;
        let surface = wl_surface::WlSurface::from_id(&connection, id)?;
        let target = surface.id().protocol_id();
        let queue = connection.new_event_queue::<Dispatcher>();
        let registry = connection.display().get_registry(&queue.handle(), ());
        connection.flush()?;
        let (shutdown, stopped) = UnixStream::pair()?;
        let worker = std::thread::Builder::new()
            .name("physical keyboard Wayland".into())
            .spawn(move || {
                let mut dispatcher = Dispatcher {
                    bridge,
                    target,
                    seats: HashMap::new(),
                    context: xkb::Context::new(xkb::CONTEXT_NO_FLAGS),
                };
                if let Err(error) = dispatch(queue, &mut dispatcher, &connection, stopped) {
                    dispatcher.bridge.fail(error);
                }
                for (_, seat) in dispatcher.seats.drain() {
                    seat.release();
                }
                let _ = connection.flush();
                drop((registry, surface));
            })?;
        Ok(Self {
            shutdown,
            worker: Some(worker),
        })
    }
}

impl Drop for Adapter {
    fn drop(&mut self) {
        let _ = self.shutdown.shutdown(std::net::Shutdown::Both);
        if let Some(worker) = self.worker.take()
            && worker.join().is_err()
        {
            tracing::warn!("Wayland keyboard thread panicked");
        }
    }
}

struct Seat {
    proxy: wl_seat::WlSeat,
    keyboard: Option<wl_keyboard::WlKeyboard>,
    keymap: Option<xkb::Keymap>,
    focused: bool,
    rate: u32,
    delay: Duration,
    repeat: Option<(u32, Instant)>,
}

impl Seat {
    fn release(self) {
        if let Some(keyboard) = self.keyboard
            && keyboard.version() >= 3
        {
            keyboard.release();
        }
        if self.proxy.version() >= 5 {
            self.proxy.release();
        }
    }
}

struct Dispatcher {
    bridge: Bridge,
    target: u32,
    seats: HashMap<u32, Seat>,
    context: xkb::Context,
}

impl Dispatcher {
    fn repeat_due(&mut self) {
        let now = Instant::now();
        for seat in self.seats.values_mut() {
            if let Some((code, due)) = seat.repeat
                && now >= due
            {
                self.bridge.key(NativeKeyCode::Evdev(code), true, true);
                seat.repeat = Some((
                    code,
                    now + Duration::from_secs_f64(1. / f64::from(seat.rate.max(1))),
                ));
            }
        }
    }

    fn timeout(&self) -> PollTimeout {
        let next = self
            .seats
            .values()
            .filter_map(|seat| seat.repeat.map(|(_, due)| due))
            .min();
        next.map_or(PollTimeout::NONE, |due| {
            let duration = due.saturating_duration_since(Instant::now());
            PollTimeout::try_from(duration.as_millis().saturating_add(1))
                .unwrap_or(PollTimeout::MAX)
        })
    }
}

fn dispatch(
    mut queue: EventQueue<Dispatcher>,
    state: &mut Dispatcher,
    connection: &Connection,
    shutdown: UnixStream,
) -> Result<(), Error> {
    loop {
        queue.dispatch_pending(state)?;
        state.repeat_due();
        if let Err(error) = connection.flush()
            && !matches!(&error, WaylandError::Io(error) if error.kind() == io::ErrorKind::WouldBlock)
        {
            return Err(error.into());
        }
        let Some(read) = connection.prepare_read() else {
            continue;
        };
        let mut fds = [
            PollFd::new(connection.as_fd(), PollFlags::POLLIN),
            PollFd::new(shutdown.as_fd(), PollFlags::POLLIN),
        ];
        match poll(&mut fds, state.timeout()) {
            Err(Errno::EINTR) => continue,
            result => {
                result?;
            }
        }
        if fds[1].revents().is_some_and(|events| !events.is_empty()) {
            drop(read);
            return Ok(());
        }
        if fds[0].revents().is_none_or(|events| events.is_empty()) {
            drop(read);
            continue;
        }
        if let Err(error) = read.read()
            && !matches!(&error, WaylandError::Io(error) if error.kind() == io::ErrorKind::WouldBlock)
        {
            return Err(error.into());
        }
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for Dispatcher {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        queue: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } if interface == "wl_seat" => {
                let proxy = registry.bind(name, version.min(7), queue, name);
                state.seats.insert(
                    name,
                    Seat {
                        proxy,
                        keyboard: None,
                        keymap: None,
                        focused: false,
                        rate: 0,
                        delay: Duration::ZERO,
                        repeat: None,
                    },
                );
            }
            wl_registry::Event::GlobalRemove { name } => {
                if let Some(seat) = state.seats.remove(&name) {
                    if seat.focused {
                        state.bridge.reset();
                    }
                    seat.release();
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_seat::WlSeat, u32> for Dispatcher {
    fn event(
        state: &mut Self,
        proxy: &wl_seat::WlSeat,
        event: wl_seat::Event,
        name: &u32,
        _: &Connection,
        queue: &QueueHandle<Self>,
    ) {
        let Some(seat) = state.seats.get_mut(name) else {
            return;
        };
        if let wl_seat::Event::Capabilities {
            capabilities: WEnum::Value(capabilities),
        } = event
        {
            if capabilities.contains(wl_seat::Capability::Keyboard) {
                if seat.keyboard.is_none() {
                    seat.keyboard = Some(proxy.get_keyboard(queue, *name));
                }
            } else if let Some(keyboard) = seat.keyboard.take() {
                seat.repeat = None;
                if seat.focused {
                    state.bridge.reset();
                }
                seat.focused = false;
                if keyboard.version() >= 3 {
                    keyboard.release();
                }
            }
        }
    }
}

impl Dispatch<wl_keyboard::WlKeyboard, u32> for Dispatcher {
    fn event(
        state: &mut Self,
        _: &wl_keyboard::WlKeyboard,
        event: wl_keyboard::Event,
        name: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(seat) = state.seats.get_mut(name) else {
            return;
        };
        match event {
            wl_keyboard::Event::Keymap {
                format: WEnum::Value(wl_keyboard::KeymapFormat::XkbV1),
                fd,
                size,
            } => {
                // The protocol defines a mapping from file offset zero, not
                // the descriptor's current seek position.
                let mut bytes = vec![0; size as usize];
                match std::fs::File::from(fd).read_exact_at(&mut bytes, 0) {
                    Ok(()) => {
                        bytes.truncate(
                            bytes
                                .iter()
                                .position(|byte| *byte == 0)
                                .unwrap_or(bytes.len()),
                        );
                        match String::from_utf8(bytes) {
                            Ok(text) => {
                                seat.keymap = xkb::Keymap::new_from_string(
                                    &state.context,
                                    text,
                                    xkb::KEYMAP_FORMAT_TEXT_V1,
                                    xkb::KEYMAP_COMPILE_NO_FLAGS,
                                );
                                if seat.keymap.is_none() {
                                    state
                                        .bridge
                                        .fail("could not parse the Wayland keyboard map");
                                }
                            }
                            Err(error) => state.bridge.fail(error),
                        }
                    }
                    Err(error) => state.bridge.fail(error),
                }
            }
            wl_keyboard::Event::Enter { surface, keys, .. } => {
                seat.focused = surface.id().protocol_id() == state.target;
                if seat.focused {
                    // The compositor supplies keys already down on focus entry.
                    for bytes in keys.as_chunks::<4>().0 {
                        let code = u32::from_ne_bytes(*bytes);
                        state.bridge.key(NativeKeyCode::Evdev(code), true, false);
                    }
                }
            }
            wl_keyboard::Event::Leave { .. } if seat.focused => {
                seat.focused = false;
                seat.repeat = None;
                state.bridge.reset();
            }
            wl_keyboard::Event::RepeatInfo { rate, delay } => {
                seat.rate = u32::try_from(rate).unwrap_or(0);
                seat.delay = Duration::from_millis(u64::try_from(delay).unwrap_or(0));
                if seat.rate == 0 {
                    seat.repeat = None;
                }
            }
            wl_keyboard::Event::Key {
                key,
                state: WEnum::Value(key_state),
                ..
            } if seat.focused => {
                let pressed = key_state == wl_keyboard::KeyState::Pressed;
                state.bridge.key(NativeKeyCode::Evdev(key), pressed, false);
                if pressed
                    && seat.rate > 0
                    && seat
                        .keymap
                        .as_ref()
                        .is_some_and(|map| map.key_repeats(xkb::Keycode::new(key + 8)))
                {
                    seat.repeat = Some((key, Instant::now() + seat.delay));
                } else if !pressed && seat.repeat.is_some_and(|(code, _)| code == key) {
                    seat.repeat = None;
                }
            }
            _ => {}
        }
    }
}
