//! Physical keyboard events from the existing GPUI HWND.

#![allow(unsafe_code)] // This module owns the HWND callback FFI boundary.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::marker::PhantomData;
use std::rc::Rc;

use deskfleet_input::NativeKeyCode;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyboardLayout, MAPVK_VK_TO_VSC_EX, MapVirtualKeyExW, ToUnicodeEx,
    VK_CANCEL, VK_CONTROL, VK_F4, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_PAUSE,
    VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN,
};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, HHOOK, MSG, PM_NOREMOVE, PM_REMOVE, PeekMessageW, SC_CLOSE, SetWindowsHookExW,
    UnhookWindowsHookEx, WH_GETMESSAGE, WM_KEYDOWN, WM_KEYFIRST, WM_KEYLAST, WM_KEYUP,
    WM_KILLFOCUS, WM_NCDESTROY, WM_NULL, WM_SETFOCUS, WM_SYSCOMMAND, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

use super::Bridge;

thread_local! {
    // IDs avoid borrowing application memory through a window-procedure pointer.
    // A late native callback after teardown simply finds no registration.
    static BRIDGES: RefCell<HashMap<usize, Registration>> = RefCell::new(HashMap::new());
    static NEXT_ID: Cell<usize> = const { Cell::new(1) };
    static ALT_GRAPH_LAYOUTS: RefCell<HashMap<usize, bool>> = RefCell::new(HashMap::new());
    static MESSAGE_HOOK: Cell<Option<HHOOK>> = const { Cell::new(None) };
}

struct Registration {
    hwnd: HWND,
    bridge: Bridge,
}

pub(super) struct Adapter {
    hwnd: HWND,
    id: usize,
    // Window subclass installation and removal must use the owning UI thread.
    _thread: PhantomData<Rc<()>>,
}

impl Adapter {
    pub(super) fn new(window: &gpui::Window, bridge: Bridge) -> Result<Self, crate::Error> {
        let RawWindowHandle::Win32(handle) = HasWindowHandle::window_handle(window)?.as_raw()
        else {
            return Err("physical keyboard requires a Win32 window".into());
        };
        let hwnd = HWND(handle.hwnd.get() as *mut std::ffi::c_void);
        let id = NEXT_ID
            .with(|next| {
                let id = next.get();
                next.set(id.checked_add(1)?);
                Some(id)
            })
            .ok_or("physical keyboard registration ids exhausted")?;
        BRIDGES.with(|bridges| {
            bridges.borrow_mut().insert(
                id,
                Registration {
                    hwnd,
                    bridge: bridge.clone(),
                },
            );
        });
        if let Err(error) = install_message_hook() {
            BRIDGES.with(|bridges| bridges.borrow_mut().remove(&id));
            return Err(error);
        }
        // SAFETY: GPUI supplies a live HWND on its owning thread. The callback
        // retrieves owned Bridge clones by ID and never dereferences ref data.
        let installed = unsafe { SetWindowSubclass(hwnd, Some(keyboard_proc), id, 0) };
        if !installed.as_bool() {
            BRIDGES.with(|bridges| bridges.borrow_mut().remove(&id));
            remove_unused_message_hook();
            return Err("could not install physical keyboard window callback".into());
        }
        snapshot_modifiers(&bridge);
        Ok(Self {
            hwnd,
            id,
            _thread: PhantomData,
        })
    }
}

impl Drop for Adapter {
    fn drop(&mut self) {
        BRIDGES.with(|bridges| bridges.borrow_mut().remove(&self.id));
        remove_unused_message_hook();
        // SAFETY: Adapter cannot leave the UI thread. Removing a callback from
        // an already-destroyed HWND is harmless; no application pointer remains.
        let _ = unsafe { RemoveWindowSubclass(self.hwnd, Some(keyboard_proc), self.id) };
    }
}

/// # Safety
/// Invoked by Windows for the HWND and subclass ID registered in `Adapter::new`.
unsafe extern "system" fn keyboard_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    _data: usize,
) -> LRESULT {
    // End the registry borrow before calling native code: PeekMessage and the
    // next window procedure can synchronously dispatch another window message.
    let bridge =
        BRIDGES.with(|bridges| bridges.borrow().get(&id).map(|entry| entry.bridge.clone()));
    if let Some(bridge) = bridge {
        match message {
            WM_NCDESTROY => {
                BRIDGES.with(|bridges| bridges.borrow_mut().remove(&id));
                remove_unused_message_hook();
                bridge.reset();
                // SAFETY: This is the callback's own live HWND/subclass pair.
                let _ = unsafe { RemoveWindowSubclass(hwnd, Some(keyboard_proc), id) };
            }
            WM_KILLFOCUS => bridge.reset(),
            WM_SETFOCUS => snapshot_modifiers(&bridge),
            _ => {}
        }
    }
    // SAFETY: Preserve the native subclass chain with the original parameters.
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

fn install_message_hook() -> Result<(), crate::Error> {
    if MESSAGE_HOOK.with(Cell::get).is_some() {
        return Ok(());
    }
    // SAFETY: This hook observes only the owning UI thread, in this process.
    // Its callback uses a thread-local registry, not borrowed application data.
    let hook = unsafe {
        SetWindowsHookExW(
            WH_GETMESSAGE,
            Some(keyboard_message),
            None,
            GetCurrentThreadId(),
        )
    }?;
    MESSAGE_HOOK.with(|value| value.set(Some(hook)));
    Ok(())
}

fn remove_unused_message_hook() {
    if BRIDGES.with(|bridges| !bridges.borrow().is_empty()) {
        return;
    }
    if let Some(hook) = MESSAGE_HOOK.with(Cell::take) {
        // SAFETY: This is this thread's hook handle. No registry entries remain,
        // so even a callback already in flight has no borrowed state to access.
        let _ = unsafe { UnhookWindowsHookEx(hook) };
    }
}

/// # Safety
/// Windows invokes this hook with an MSG pointer for nonnegative hook codes.
unsafe extern "system" fn keyboard_message(code: i32, removal: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 && removal.0 == PM_REMOVE.0 as usize {
        // SAFETY: WH_GETMESSAGE supplies a writable MSG valid during this call.
        let message = unsafe { &mut *(data.0 as *mut MSG) };
        if matches!(
            message.message,
            WM_KEYDOWN | WM_KEYUP | WM_SYSKEYDOWN | WM_SYSKEYUP
        ) {
            let bridge = BRIDGES.with(|bridges| {
                bridges
                    .borrow()
                    .values()
                    .find(|entry| entry.hwnd == message.hwnd)
                    .map(|entry| entry.bridge.clone())
            });
            if let Some(bridge) = bridge {
                if message.message == WM_SYSKEYDOWN && message.wParam.0 == usize::from(VK_F4.0) {
                    // GPUI intercepts keys before DispatchMessage; route the
                    // native close command directly through its normal window
                    // procedure so its remote-focused key handler cannot eat it.
                    message.message = WM_SYSCOMMAND;
                    message.wParam = WPARAM(SC_CLOSE as usize);
                    message.lParam = LPARAM(0);
                } else {
                    if !fake_altgr_control(message)
                        && let Some((native, pressed, repeat)) =
                            key(message.message, message.wParam, message.lParam)
                    {
                        bridge.key(native, pressed, repeat);
                        // Pause has no reliable native key-up message.
                        if pressed
                            && (message.wParam.0 == usize::from(VK_PAUSE.0)
                                || message.wParam.0 == usize::from(VK_CANCEL.0))
                        {
                            bridge.key(native, false, false);
                        }
                    }
                    if bridge.enabled() {
                        // Consume before GPUI's translate_accelerator converts
                        // keydown into its private message and starts IME input.
                        message.message = WM_NULL;
                        message.wParam = WPARAM(0);
                        message.lParam = LPARAM(0);
                    }
                }
            }
        }
    }
    // SAFETY: Continue the hook chain with the MSG pointer supplied by Windows.
    unsafe { CallNextHookEx(None, code, removal, data) }
}

fn key(message: u32, wparam: WPARAM, lparam: LPARAM) -> Option<(NativeKeyCode, bool, bool)> {
    // The message stores an 8-bit scan code and the E0 prefix separately.
    let bits = lparam.0 as usize;
    let mut scan_code = u16::try_from((bits >> 16) & 0xff).ok()?;
    let mut extended = bits & (1 << 24) != 0;
    if wparam.0 == usize::from(VK_PAUSE.0) || wparam.0 == usize::from(VK_CANCEL.0) {
        scan_code = 0x45;
        extended = false;
    }
    // Windows synthesizes E0-shift around some numpad/PrintScreen sequences.
    if scan_code == 0 || extended && matches!(scan_code, 0x2a | 0x36) {
        return None;
    }
    let pressed = matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN);
    let repeat = pressed && bits & (1 << 30) != 0;
    Some((
        NativeKeyCode::Windows {
            scan_code,
            extended,
        },
        pressed,
        repeat,
    ))
}

fn fake_altgr_control(message: &MSG) -> bool {
    if message.wParam.0 != usize::from(VK_CONTROL.0) || message.lParam.0 as usize & (1 << 24) != 0 {
        return false;
    }
    let mut next = MSG::default();
    // SAFETY: `next` is writable. PM_NOREMOVE inspects this HWND's next keyboard
    // message without taking it away from GPUI's event loop.
    let available = unsafe {
        PeekMessageW(
            &mut next,
            Some(message.hwnd),
            WM_KEYFIRST,
            WM_KEYLAST,
            PM_NOREMOVE,
        )
    };
    if !available.as_bool()
        || !matches!(
            next.message,
            WM_KEYDOWN | WM_KEYUP | WM_SYSKEYDOWN | WM_SYSKEYUP
        )
    {
        return false;
    }
    let same_transition = matches!(message.message, WM_KEYDOWN | WM_SYSKEYDOWN)
        == matches!(next.message, WM_KEYDOWN | WM_SYSKEYDOWN);
    let next_bits = next.lParam.0 as usize;
    same_transition
        && next.time == message.time
        && (next_bits >> 16) & 0xff == 0x38
        && next_bits & (1 << 24) != 0
        && layout_has_alt_graph()
}

fn layout_has_alt_graph() -> bool {
    // SAFETY: Zero selects the calling UI thread's current keyboard layout.
    let layout = unsafe { GetKeyboardLayout(0) };
    if let Some(value) =
        ALT_GRAPH_LAYOUTS.with(|layouts| layouts.borrow().get(&(layout.0 as usize)).copied())
    {
        return value;
    }
    let plain = [0u8; 256];
    let mut modified = plain;
    modified[usize::from(VK_CONTROL.0)] = 0x80;
    modified[usize::from(VK_MENU.0)] = 0x80;
    let mut unmodified_text = [0u16; 8];
    let mut modified_text = [0u16; 8];
    let found = (0..256).any(|virtual_key| {
        // SAFETY: All virtual keys are in the documented range. Keyboard state
        // and output buffers are valid; flag 4 prevents changing dead-key state.
        let (plain_len, modified_len) = unsafe {
            let scan = MapVirtualKeyExW(virtual_key, MAPVK_VK_TO_VSC_EX, Some(layout));
            if scan == 0 {
                return false;
            }
            (
                ToUnicodeEx(
                    virtual_key,
                    scan,
                    &plain,
                    &mut unmodified_text,
                    4,
                    Some(layout),
                ),
                ToUnicodeEx(
                    virtual_key,
                    scan,
                    &modified,
                    &mut modified_text,
                    4,
                    Some(layout),
                ),
            )
        };
        let (Ok(plain_len), Ok(modified_len)) =
            (usize::try_from(plain_len), usize::try_from(modified_len))
        else {
            return false;
        };
        plain_len > 0
            && modified_len > 0
            && unmodified_text.get(..plain_len) != modified_text.get(..modified_len)
    });
    ALT_GRAPH_LAYOUTS.with(|layouts| layouts.borrow_mut().insert(layout.0 as usize, found));
    found
}

fn snapshot_modifiers(bridge: &Bridge) {
    // SAFETY: This focus-gain snapshot reads current key state, which may have
    // changed while this thread's window was inactive and received no events.
    let right_alt = unsafe { GetAsyncKeyState(i32::from(VK_RMENU.0)) } < 0;
    let alt_graph = right_alt && layout_has_alt_graph();
    for (virtual_key, scan_code, extended) in [
        (VK_LSHIFT, 0x2a, false),
        (VK_RSHIFT, 0x36, false),
        (VK_LCONTROL, 0x1d, false),
        (VK_RCONTROL, 0x1d, true),
        (VK_LMENU, 0x38, false),
        (VK_RMENU, 0x38, true),
        (VK_LWIN, 0x5b, true),
        (VK_RWIN, 0x5c, true),
    ] {
        // When focus arrives during AltGr, Windows exposes its synthetic left
        // Control in the aggregate state. A later real Control event is kept.
        if virtual_key == VK_LCONTROL && alt_graph {
            continue;
        }
        // SAFETY: Every virtual key above is a defined modifier key.
        let pressed = unsafe { GetAsyncKeyState(i32::from(virtual_key.0)) } < 0;
        bridge.key(
            NativeKeyCode::Windows {
                scan_code,
                extended,
            },
            pressed,
            false,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_messages_keep_extended_keys_and_repeat() {
        let enter = key(WM_KEYDOWN, WPARAM(0x0d), LPARAM(0x001c_0001));
        let keypad_enter = key(WM_KEYDOWN, WPARAM(0x0d), LPARAM(0x411c_0001));
        assert!(matches!(
            enter,
            Some((
                NativeKeyCode::Windows {
                    scan_code: 0x1c,
                    extended: false
                },
                true,
                false
            ))
        ));
        assert!(matches!(
            keypad_enter,
            Some((
                NativeKeyCode::Windows {
                    scan_code: 0x1c,
                    extended: true
                },
                true,
                true
            ))
        ));
        assert!(key(WM_KEYDOWN, WPARAM(0x10), LPARAM(0x012a_0001)).is_none());
    }
}
