//! Observe key events on GPUI's X11 window using a separate client connection.

use std::collections::HashSet;
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::thread::JoinHandle;

use deskfleet_input::NativeKeyCode;
use nix::errno::Errno;
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
use x11rb::{
    connection::Connection,
    protocol::{
        Event,
        xkb::{self, ConnectionExt as _},
        xproto::{ChangeWindowAttributesAux, ConnectionExt as _, EventMask},
    },
    rust_connection::RustConnection,
};

use super::Bridge;
use crate::Error;

pub(super) struct Adapter {
    shutdown: UnixStream,
    worker: Option<JoinHandle<()>>,
}

impl Adapter {
    pub(super) fn new(window: u32, bridge: Bridge) -> Result<Self, Error> {
        let (connection, _) = RustConnection::connect(None)?;
        if !connection.xkb_use_extension(1, 0)?.reply()?.supported {
            return Err("physical keyboard input requires XKB".into());
        }
        let repeat = xkb::PerClientFlag::DETECTABLE_AUTO_REPEAT;
        let flags = connection
            .xkb_per_client_flags(
                xkb::ID::USE_CORE_KBD.into(),
                repeat,
                repeat,
                xkb::BoolCtrl::default(),
                xkb::BoolCtrl::default(),
                xkb::BoolCtrl::default(),
            )?
            .reply()?;
        if !flags.value.contains(repeat) {
            return Err("X11 server does not support detectable keyboard repeat".into());
        }
        // Event masks belong to each X client; this does not change GPUI's mask.
        connection
            .change_window_attributes(
                window,
                &ChangeWindowAttributesAux::new().event_mask(
                    EventMask::KEY_PRESS
                        | EventMask::KEY_RELEASE
                        | EventMask::FOCUS_CHANGE
                        | EventMask::STRUCTURE_NOTIFY,
                ),
            )?
            .check()?;
        connection.flush()?;
        let (shutdown, stopped) = UnixStream::pair()?;
        let worker = std::thread::Builder::new()
            .name("physical keyboard X11".into())
            .spawn(move || {
                if let Err(error) = dispatch(connection, window, &bridge, stopped) {
                    bridge.fail(error);
                }
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
            tracing::warn!("X11 keyboard thread panicked");
        }
    }
}

fn dispatch(
    connection: RustConnection,
    window: u32,
    bridge: &Bridge,
    shutdown: UnixStream,
) -> Result<(), Error> {
    let mut held = HashSet::new();
    loop {
        while let Some(event) = connection.poll_for_event()? {
            match event {
                Event::KeyPress(event) if event.event == window => {
                    let repeat = !held.insert(event.detail);
                    if let Some(code) = event.detail.checked_sub(8) {
                        bridge.key(NativeKeyCode::Evdev(u32::from(code)), true, repeat);
                    }
                }
                Event::KeyRelease(event) if event.event == window => {
                    held.remove(&event.detail);
                    if let Some(code) = event.detail.checked_sub(8) {
                        bridge.key(NativeKeyCode::Evdev(u32::from(code)), false, false);
                    }
                }
                Event::FocusIn(event) if event.event == window => {
                    held.clear();
                    let keys = connection.query_keymap()?.reply()?.keys;
                    for (byte_index, byte) in keys.iter().enumerate() {
                        for bit in 0..8 {
                            if byte & (1 << bit) != 0 {
                                let native = (byte_index * 8 + bit) as u8;
                                held.insert(native);
                                if let Some(code) = native.checked_sub(8) {
                                    bridge.focus_key(NativeKeyCode::Evdev(u32::from(code)));
                                }
                            }
                        }
                    }
                }
                Event::FocusOut(event) if event.event == window => {
                    held.clear();
                    bridge.reset();
                }
                Event::DestroyNotify(event) if event.window == window => {
                    bridge.reset();
                    return Ok(());
                }
                _ => {}
            }
        }
        let mut fds = [
            PollFd::new(connection.stream().as_fd(), PollFlags::POLLIN),
            PollFd::new(shutdown.as_fd(), PollFlags::POLLIN),
        ];
        match poll(&mut fds, PollTimeout::NONE) {
            Err(Errno::EINTR) => continue,
            result => {
                result?;
            }
        }
        if fds[1].revents().is_some_and(|events| !events.is_empty()) {
            return Ok(());
        }
    }
}
