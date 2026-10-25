//! Windows input through SendInput in the interactive user's desktop.

#![allow(unsafe_code)]

use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_SWAPBUTTON, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN, WHEEL_DELTA,
};
use windows::core::BOOL;

use crate::{InputError, Result};

pub(super) struct PlatformInput {
    display_id: u32,
    wheel_x: f64,
    wheel_y: f64,
    pressed_buttons: [Option<u8>; 5],
}

impl PlatformInput {
    pub(super) fn new(display_id: u32) -> Result<Self> {
        let _dpi = DpiScope::enter()?;
        display_bounds(display_id)?;
        Ok(Self {
            display_id,
            wheel_x: 0.0,
            wheel_y: 0.0,
            pressed_buttons: [None; 5],
        })
    }

    pub(super) fn move_pointer(&mut self, x: f64, y: f64) -> Result<()> {
        // A thread-local scope avoids changing Electron's process DPI policy.
        let _dpi = DpiScope::enter()?;
        let display = display_bounds(self.display_id)?;
        // SAFETY: These calls only read the current virtual desktop geometry.
        let (left, top, width, height) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        let dx = absolute_coordinate(x, display.left, display.right, left, width)?;
        let dy = absolute_coordinate(y, display.top, display.bottom, top, height)?;
        send(&[mouse_input(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            dx,
            dy,
            0,
        )])
    }

    pub(super) fn button(&mut self, button: u8, pressed: bool) -> Result<()> {
        let Some(previous) = self.pressed_buttons.get(usize::from(button)).copied() else {
            return Err(InputError::InvalidEvent("unknown mouse button"));
        };
        // DOM buttons identify primary/secondary actions. SendInput uses physical
        // switches, so compensate for a left-handed host's swapped-button setting.
        // A held press retains its physical switch until release even if settings change.
        let physical = previous.unwrap_or_else(|| {
            // SAFETY: Reads a scalar user setting without accessing caller memory.
            physical_button(button, unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0)
        });
        let (down, up, data) = match physical {
            0 => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 0),
            1 => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, 0),
            2 => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 0),
            3 => (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, 1),
            4 => (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, 2),
            _ => return Err(InputError::InvalidEvent("unknown mouse button")),
        };
        send(&[mouse_input(if pressed { down } else { up }, 0, 0, data)])?;
        self.pressed_buttons[usize::from(button)] = pressed.then_some(physical);
        Ok(())
    }

    pub(super) fn wheel(&mut self, dx: f64, dy: f64) -> Result<()> {
        // A conventional browser wheel notch is 100 CSS pixels. Retain sub-unit
        // motion so smooth trackpads do not lose small deltas through rounding.
        self.wheel_x += dx * f64::from(WHEEL_DELTA) / 100.0;
        self.wheel_y -= dy * f64::from(WHEEL_DELTA) / 100.0;
        let x = self.wheel_x.trunc() as i32;
        let y = self.wheel_y.trunc() as i32;
        if x != 0 {
            send(&[mouse_input(MOUSEEVENTF_HWHEEL, 0, 0, x as u32)])?;
            self.wheel_x -= f64::from(x);
        }
        if y != 0 {
            send(&[mouse_input(MOUSEEVENTF_WHEEL, 0, 0, y as u32)])?;
            self.wheel_y -= f64::from(y);
        }
        Ok(())
    }

    pub(super) fn key(&mut self, code: &str, pressed: bool, _repeat: bool) -> Result<()> {
        let mut flags = if pressed {
            KEYBD_EVENT_FLAGS(0)
        } else {
            KEYEVENTF_KEYUP
        };
        // Pause has an E1 scan sequence that KEYEVENTF_EXTENDEDKEY cannot encode.
        let (virtual_key, scan) = if code == "Pause" {
            (VK_PAUSE, 0)
        } else {
            let (scan, extended) = super::windows_keys::scan_code(code)?;
            flags |= KEYEVENTF_SCANCODE;
            if extended {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }
            (VIRTUAL_KEY(0), scan)
        };
        send(&[INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: virtual_key,
                    wScan: scan,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        }])
    }
}

fn physical_button(button: u8, swapped: bool) -> u8 {
    match (button, swapped) {
        (0, true) => 2,
        (2, true) => 0,
        _ => button,
    }
}

fn mouse_input(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}

fn send(inputs: &[INPUT]) -> Result<()> {
    // SAFETY: Each INPUT has the matching initialized union variant. SendInput
    // reads the live slice synchronously and receives the required structure size.
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        return Ok(());
    }
    Err(InputError::Platform(format!(
        "SendInput accepted {sent}/{} events ({}); elevated windows and secure desktops may reject input",
        inputs.len(),
        std::io::Error::last_os_error(),
    )))
}

fn absolute_coordinate(
    position: f64,
    start: i32,
    end: i32,
    origin: i32,
    extent: i32,
) -> Result<i32> {
    if end <= start || extent <= 0 {
        return Err(InputError::Platform(
            "display has no usable desktop bounds".into(),
        ));
    }
    let pixel = f64::from(start) + position * (f64::from(end) - f64::from(start) - 1.0);
    if extent == 1 {
        return Ok(0);
    }
    Ok(
        ((pixel - f64::from(origin)) * 65535.0 / f64::from(extent - 1))
            .round()
            .clamp(0.0, 65535.0) as i32,
    )
}

fn display_bounds(display_id: u32) -> Result<RECT> {
    struct Search {
        id: u32,
        bounds: Option<RECT>,
    }
    let mut search = Search {
        id: display_id,
        bounds: None,
    };
    // SAFETY: EnumDisplayMonitors invokes this callback synchronously with its
    // live Search pointer and a valid monitor rectangle for the callback duration.
    unsafe extern "system" fn callback(
        monitor: HMONITOR,
        _: HDC,
        rect: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        // SAFETY: data and rect are supplied under the synchronous contract above.
        let search = unsafe { &mut *(data.0 as *mut Search) };
        if monitor.0 as usize as u32 == search.id {
            // SAFETY: The OS owns this readable RECT for the duration of the callback.
            search.bounds = Some(unsafe { *rect });
        }
        BOOL(1)
    }
    // SAFETY: search stays alive and exclusively borrowed throughout enumeration.
    let success = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(callback),
            LPARAM((&raw mut search) as isize),
        )
    };
    if !success.as_bool() {
        return Err(InputError::Platform(format!(
            "enumerate input display: {}",
            std::io::Error::last_os_error()
        )));
    }
    search
        .bounds
        .ok_or_else(|| InputError::Platform("selected display is no longer connected".into()))
}

struct DpiScope(DPI_AWARENESS_CONTEXT);

impl DpiScope {
    fn enter() -> Result<Self> {
        // SAFETY: This only changes the calling worker's DPI context. The returned
        // previous context is restored before returning from the input operation.
        let previous =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        if previous.0.is_null() {
            return Err(InputError::Platform(format!(
                "set input DPI context: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(Self(previous))
    }
}

impl Drop for DpiScope {
    fn drop(&mut self) {
        // SAFETY: This is the context returned by a successful change on this thread.
        unsafe {
            SetThreadDpiAwarenessContext(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordinates_include_negative_origin_and_both_display_edges() {
        assert_eq!(absolute_coordinate(0.0, -1920, 0, -1920, 3840).unwrap(), 0);
        assert_eq!(
            absolute_coordinate(1.0, 0, 1920, -1920, 3840).unwrap(),
            65535
        );
        assert_eq!(
            absolute_coordinate(0.0, 0, 1920, -1920, 3840).unwrap(),
            32776
        );
        assert!(absolute_coordinate(0.5, 0, 0, 0, 1920).is_err());
    }

    #[test]
    fn button_and_key_packets_use_the_expected_union() {
        let packet = mouse_input(MOUSEEVENTF_XDOWN, 0, 0, 2);
        assert_eq!(packet.r#type, INPUT_MOUSE);
        // SAFETY: mouse_input initializes the mi variant.
        assert_eq!(unsafe { packet.Anonymous.mi.mouseData }, 2);
    }

    #[test]
    fn logical_primary_and_secondary_compensate_for_swapped_host_buttons() {
        assert_eq!(physical_button(0, false), 0);
        assert_eq!(physical_button(0, true), 2);
        assert_eq!(physical_button(2, true), 0);
        for button in [1, 3, 4] {
            assert_eq!(physical_button(button, true), button);
        }
    }
}
