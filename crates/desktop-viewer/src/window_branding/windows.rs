//! Own the viewer's Win32 title-bar and task-switcher icon.

#![allow(unsafe_code)] // This module owns the HWND icon FFI boundary.

use std::marker::PhantomData;
use std::rc::Rc;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateIconFromResourceEx, DestroyIcon, HICON, ICON_BIG, ICON_SMALL, IsWindow, LR_DEFAULTCOLOR,
    SendMessageW, WM_SETICON,
};

// CreateIconFromResourceEx requires DWORD-aligned resource bytes.
#[repr(align(4))]
struct IconResource([u8; super::ICON.len()]);

static ICON_RESOURCE: IconResource = {
    let mut bytes = [0; super::ICON.len()];
    bytes.copy_from_slice(super::ICON);
    IconResource(bytes)
};

pub(crate) struct WindowIcon {
    hwnd: HWND,
    icon: HICON,
    previous_big: LPARAM,
    previous_small: LPARAM,
    // Icon installation and removal must stay on the window's owning thread.
    _thread: PhantomData<Rc<()>>,
}

impl WindowIcon {
    pub(crate) fn new(window: &gpui::Window) -> Result<Self, crate::Error> {
        let RawWindowHandle::Win32(handle) = HasWindowHandle::window_handle(window)?.as_raw()
        else {
            return Err("window icon requires a Win32 window".into());
        };
        let hwnd = HWND(handle.hwnd.get() as *mut std::ffi::c_void);
        // SAFETY: The aligned embedded PNG is a complete 256px icon resource.
        // Omitting LR_SHARED gives this owner a handle to destroy later.
        let icon = unsafe {
            CreateIconFromResourceEx(
                &ICON_RESOURCE.0,
                true,
                0x0003_0000,
                256,
                256,
                LR_DEFAULTCOLOR,
            )?
        };
        // SAFETY: GPUI provides the live HWND on its UI thread. WM_SETICON
        // borrows our icon until it is replaced or the window is destroyed.
        let (previous_big, previous_small) = unsafe {
            let value = Some(LPARAM(icon.0 as isize));
            (
                SendMessageW(hwnd, WM_SETICON, Some(WPARAM(ICON_BIG as usize)), value),
                SendMessageW(hwnd, WM_SETICON, Some(WPARAM(ICON_SMALL as usize)), value),
            )
        };
        Ok(Self {
            hwnd,
            icon,
            previous_big: LPARAM(previous_big.0),
            previous_small: LPARAM(previous_small.0),
            _thread: PhantomData,
        })
    }
}

impl Drop for WindowIcon {
    fn drop(&mut self) {
        // SAFETY: This owner stays on the window's UI thread. IsWindow accepts
        // a destroyed HWND; a live window must release our icon before it is
        // destroyed. The previous handles are borrowed, never owned here.
        unsafe {
            if IsWindow(Some(self.hwnd)).as_bool() {
                SendMessageW(
                    self.hwnd,
                    WM_SETICON,
                    Some(WPARAM(ICON_BIG as usize)),
                    Some(self.previous_big),
                );
                SendMessageW(
                    self.hwnd,
                    WM_SETICON,
                    Some(WPARAM(ICON_SMALL as usize)),
                    Some(self.previous_small),
                );
            }
            if let Err(error) = DestroyIcon(self.icon) {
                tracing::warn!(%error, "could not release native window icon");
            }
        }
    }
}
