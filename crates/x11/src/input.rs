use std::collections::{BTreeMap, BTreeSet};

use x11rb::protocol::xkb::ConnectionExt as _;
use x11rb::protocol::xproto::{
    BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, KEY_PRESS_EVENT, KEY_RELEASE_EVENT,
    MOTION_NOTIFY_EVENT,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

use crate::{Error, Result, Source, connection::Watchdog, display, keys, platform};

pub(crate) fn initialize(connection: &RustConnection) -> Result<()> {
    connection
        .xtest_get_version(2, 2)
        .map_err(platform)?
        .reply()
        .map_err(platform)?;
    let xkb = connection
        .xkb_use_extension(1, 0)
        .map_err(platform)?
        .reply()
        .map_err(platform)?;
    if !xkb.supported {
        return Err(Error::Unavailable(
            "XKB keyboard names are unavailable".into(),
        ));
    }
    // A named alphanumeric key confirms that the server exposes physical names.
    keys::resolve(connection, 30)?;
    Ok(())
}

/// One controller connection. Held X keycodes are retained through keyboard
/// remapping so release targets the original press, including on drop.
pub struct InputConnection {
    connection: RustConnection,
    source: Source,
    keys: BTreeMap<u32, u8>,
    buttons: BTreeSet<u8>,
    scroll: (f64, f64),
    source_error: Option<Error>,
    watchdog: Watchdog,
}

impl InputConnection {
    pub fn new(source_id: u32) -> Result<Self> {
        let (connection, deadline) = display::connect_with_deadline()?;
        deadline.finish(initialize(&connection))?;
        let source = deadline.finish(display::select(&connection, source_id))?;
        drop(deadline);
        let watchdog = Watchdog::new(connection.stream())?;
        Ok(Self {
            watchdog,
            connection,
            source,
            keys: BTreeMap::new(),
            buttons: BTreeSet::new(),
            scroll: (0.0, 0.0),
            source_error: None,
        })
    }

    fn check_source(&mut self) -> Result<()> {
        if let Some(error) = &self.source_error {
            return Err(error.clone());
        }
        display::check_changes(&self.connection, &self.source).inspect_err(|error| {
            self.source_error = Some(error.clone());
            let _ = self.release_all_inner();
        })
    }

    pub fn move_pointer(&mut self, x: f64, y: f64) -> Result<()> {
        let deadline = self.watchdog.operation()?;
        deadline.finish(self.move_pointer_inner(x, y))
    }

    fn move_pointer_inner(&mut self, x: f64, y: f64) -> Result<()> {
        self.check_source()?;
        let (x, y) = coordinates(&self.source, x, y)?;
        self.connection
            .xtest_fake_input(MOTION_NOTIFY_EVENT, 0, 0, self.source.root, x, y, 0)
            .map_err(platform)?
            .check()
            .map_err(platform)
    }

    /// Linux evdev button code (BTN_LEFT = 272).
    pub fn button(&mut self, code: u32, pressed: bool) -> Result<()> {
        let deadline = self.watchdog.operation()?;
        deadline.finish(self.button_inner(code, pressed))
    }

    fn button_inner(&mut self, code: u32, pressed: bool) -> Result<()> {
        let button = match code {
            0x110 => 1,
            0x112 => 2,
            0x111 => 3,
            0x113 => 8,
            0x114 => 9,
            _ => return Err(Error::InvalidInput("unknown mouse button")),
        };
        if pressed {
            self.check_source()?;
        } else if !self.buttons.contains(&button) {
            return Ok(());
        }
        self.fake(
            if pressed {
                BUTTON_PRESS_EVENT
            } else {
                BUTTON_RELEASE_EVENT
            },
            button,
        )?;
        if pressed {
            self.buttons.insert(button);
        } else {
            self.buttons.remove(&button);
        }
        Ok(())
    }

    /// Physical evdev code, translated using the current XKB key names.
    pub fn key(&mut self, code: u32, pressed: bool) -> Result<()> {
        let deadline = self.watchdog.operation()?;
        deadline.finish(self.key_inner(code, pressed))
    }

    fn key_inner(&mut self, code: u32, pressed: bool) -> Result<()> {
        if pressed {
            self.check_source()?;
        } else if !self.keys.contains_key(&code) {
            return Ok(());
        }
        let keycode = match self.keys.get(&code) {
            Some(&keycode) => keycode,
            None => keys::resolve(&self.connection, code)?,
        };
        self.fake(
            if pressed {
                KEY_PRESS_EVENT
            } else {
                KEY_RELEASE_EVENT
            },
            keycode,
        )?;
        if pressed {
            self.keys.insert(code, keycode);
        } else {
            self.keys.remove(&code);
        }
        Ok(())
    }

    /// XTEST represents wheel ticks as buttons. Accumulate browser pixel deltas
    /// so touchpad sub-tick movement is preserved; positive means right/down.
    pub fn wheel(&mut self, dx: f64, dy: f64) -> Result<()> {
        let deadline = self.watchdog.operation()?;
        deadline.finish(self.wheel_inner(dx, dy))
    }

    fn wheel_inner(&mut self, dx: f64, dy: f64) -> Result<()> {
        self.check_source()?;
        let horizontal = scroll_ticks(&mut self.scroll.0, dx)?;
        let vertical = scroll_ticks(&mut self.scroll.1, dy)?;
        for (ticks, negative, positive) in [(horizontal, 6, 7), (vertical, 4, 5)] {
            let button = if ticks < 0 { negative } else { positive };
            for _ in 0..ticks.unsigned_abs() {
                self.fake(BUTTON_PRESS_EVENT, button)?;
                self.fake(BUTTON_RELEASE_EVENT, button)?;
            }
        }
        Ok(())
    }

    pub fn release_all(&mut self) -> Result<()> {
        let deadline = self.watchdog.operation()?;
        deadline.finish(self.release_all_inner())
    }

    fn release_all_inner(&mut self) -> Result<()> {
        let mut error = None;
        for (code, keycode) in self
            .keys
            .iter()
            .map(|(&code, &keycode)| (code, keycode))
            .collect::<Vec<_>>()
        {
            if let Err(current) = self.fake(KEY_RELEASE_EVENT, keycode) {
                error.get_or_insert(current);
            } else {
                self.keys.remove(&code);
            }
        }
        for button in self.buttons.iter().copied().collect::<Vec<_>>() {
            if let Err(current) = self.fake(BUTTON_RELEASE_EVENT, button) {
                error.get_or_insert(current);
            } else {
                self.buttons.remove(&button);
            }
        }
        self.scroll = (0.0, 0.0);
        error.map_or(Ok(()), Err)
    }

    fn fake(&self, kind: u8, detail: u8) -> Result<()> {
        self.connection
            .xtest_fake_input(kind, detail, 0, 0, 0, 0, 0)
            .map_err(platform)?
            .check()
            .map_err(platform)
    }
}

impl Drop for InputConnection {
    fn drop(&mut self) {
        if let Err(error) = self.release_all() {
            tracing::warn!(%error, "X11 input cleanup failed");
        }
    }
}

fn coordinates(source: &Source, x: f64, y: f64) -> Result<(i16, i16)> {
    if !x.is_finite() || !y.is_finite() || !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
        return Err(Error::InvalidInput(
            "pointer coordinates must be within 0..1",
        ));
    }
    let x = i32::from(source.x) + (x * f64::from(source.width.saturating_sub(1))).round() as i32;
    let y = i32::from(source.y) + (y * f64::from(source.height.saturating_sub(1))).round() as i32;
    Ok((
        i16::try_from(x)
            .map_err(|_| Error::InvalidInput("pointer coordinate exceeds XTEST range"))?,
        i16::try_from(y)
            .map_err(|_| Error::InvalidInput("pointer coordinate exceeds XTEST range"))?,
    ))
}

fn scroll_ticks(remainder: &mut f64, delta: f64) -> Result<i32> {
    if !delta.is_finite() || delta.abs() > 10_000.0 {
        return Err(Error::InvalidInput("invalid wheel delta"));
    }
    *remainder += delta;
    let ticks = (*remainder / 120.0).trunc() as i32;
    *remainder -= f64::from(ticks) * 120.0;
    Ok(ticks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scroll_accumulates_fractional_ticks_and_preserves_direction() {
        let mut remainder = 0.0;
        assert_eq!(scroll_ticks(&mut remainder, 70.0).unwrap(), 0);
        assert_eq!(scroll_ticks(&mut remainder, 70.0).unwrap(), 1);
        assert_eq!(remainder, 20.0);
        assert_eq!(scroll_ticks(&mut remainder, -260.0).unwrap(), -2);
        assert_eq!(remainder, 0.0);
        assert!(scroll_ticks(&mut remainder, f64::NAN).is_err());
    }

    #[test]
    fn normalized_pointer_uses_monitor_origin_and_last_pixel() {
        let source = Source {
            id: 1,
            name: "right".into(),
            width: 1920,
            height: 1080,
            refresh_rate_hz: 60.0,
            root: 1,
            x: 1920,
            y: 40,
            root_width: 3840,
            root_height: 1120,
        };
        assert_eq!(coordinates(&source, 0.0, 0.0).unwrap(), (1920, 40));
        assert_eq!(coordinates(&source, 1.0, 1.0).unwrap(), (3839, 1119));
        assert!(coordinates(&source, -0.01, 1.0).is_err());
    }
}
