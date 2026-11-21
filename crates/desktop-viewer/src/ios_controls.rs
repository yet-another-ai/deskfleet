//! A main-thread UIKit host for the shared Rust NSH controls.

#![allow(unsafe_code)] // The C ABI borrows Swift buffers and owns main-thread UIKit views.

use std::ffi::{CStr, CString, c_char, c_void};

use nsh_platform_ios::{AppView, SurfaceOptions};
use objc2::MainThreadMarker;
use objc2_foundation::NSRect;
use tokio::sync::watch;

use crate::nsh_controls::{ControlsBridge, ToolbarState, controls_root};

type ActionCallback = extern "C" fn(u64, *const c_char);

struct Controls {
    app: AppView,
    state: watch::Sender<ToolbarState>,
}

/// Creates one NSH engine and returns its opaque owner. Call on the UIKit main thread.
/// The callback may run on the NSH engine thread; its JSON is valid only during the call.
#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_ios_controls_create(
    identity: u64,
    callback: Option<ActionCallback>,
) -> *mut c_void {
    let Some(mtm) = MainThreadMarker::new() else {
        return std::ptr::null_mut();
    };
    let initial = ToolbarState {
        mobile: true,
        ..ToolbarState::default()
    };
    let (state, bridge) = ControlsBridge::new(initial, move |action| {
        if let Some(callback) = callback
            && let Ok(json) = serde_json::to_string(&action)
            && let Ok(json) = CString::new(json)
        {
            callback(identity, json.as_ptr());
        }
    });
    let app = AppView::new(mtm, NSRect::ZERO, SurfaceOptions::default());
    app.set_error_handler(|message| tracing::error!(%message, "iOS remote desktop controls"));
    app.run(controls_root(bridge));
    Box::into_raw(Box::new(Controls { app, state })).cast()
}

/// Borrows the UIView. Swift retains it in its hierarchy; the opaque owner still
/// owns the engine and must outlive all use of that view.
///
/// # Safety
/// `handle` must be a live value returned by `deskfleet_ios_controls_create`.
/// Call on the UIKit main thread.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn deskfleet_ios_controls_view(handle: *mut c_void) -> *mut c_void {
    if MainThreadMarker::new().is_none() || handle.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: the caller holds the live main-thread Controls owner.
    let controls = unsafe { &*handle.cast::<Controls>() };
    std::ptr::from_ref(controls.app.view()).cast_mut().cast()
}

/// Updates UI state without replacing the running engine.
///
/// # Safety
/// `handle` is live, and `json` points to a NUL-terminated string valid for this
/// call. Call on the UIKit main thread, before destroying the owner.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn deskfleet_ios_controls_update(handle: *mut c_void, json: *const c_char) {
    if MainThreadMarker::new().is_none() || handle.is_null() || json.is_null() {
        return;
    }
    // SAFETY: Swift keeps both the owner and withCString buffer alive for this call.
    let (controls, bytes) =
        unsafe { (&*handle.cast::<Controls>(), CStr::from_ptr(json).to_bytes()) };
    match serde_json::from_slice::<ToolbarState>(bytes) {
        Ok(next) => {
            controls.state.send_if_modified(|state| {
                if *state == next {
                    return false;
                }
                *state = next;
                true
            });
        }
        Err(error) => tracing::warn!(%error, "invalid iOS controls state"),
    }
}

/// Stops the engine and drops its UIKit owner.
///
/// # Safety
/// Call once on the UIKit main thread with a live handle, after removing the
/// borrowed UIView from its hierarchy. No further access to the handle is allowed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn deskfleet_ios_controls_destroy(handle: *mut c_void) {
    if MainThreadMarker::new().is_none() || handle.is_null() {
        return;
    }
    // SAFETY: Swift transfers the sole opaque owner back exactly once.
    drop(unsafe { Box::from_raw(handle.cast::<Controls>()) });
}
