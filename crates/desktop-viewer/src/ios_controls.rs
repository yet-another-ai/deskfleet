//! Per-window NSH host. UIKit submits viewport and input state on the main
//! thread. Layout measurements originate on the NSH engine thread.

#![allow(unsafe_code)]

use std::ffi::{CStr, CString, c_char};
use std::sync::{Arc, Mutex};

use nsh_platform_ios::{AppView, SurfaceOptions};
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_foundation::NSRect;
use objc2_ui_kit::{UIColor, UIView, UIViewAutoresizing};

use crate::mobile_overlay::MobileOverlay;
use crate::nsh_controls::{ToolbarState, controls_root};

type ActionCallback = extern "C" fn(u64, *const c_char);

struct Controls {
    app: AppView,
    overlay: Arc<Mutex<MobileOverlay>>,
}

/// # Safety
/// Swift passes the live overlay wrapper on the main thread. The returned
/// owner must be destroyed there, before the wrapper is discarded.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_controls_create(
    wrapper: &UIView,
    identity: u64,
    callback: Option<ActionCallback>,
) -> *mut Controls {
    let (overlay, bridge) =
        MobileOverlay::attach(ToolbarState::default(), [0.; 4], move |action| {
            if let Some(callback) = callback
                && let Ok(json) = serde_json::to_string(&action)
                && let Ok(json) = CString::new(json)
            {
                callback(identity, json.as_ptr());
            }
        });
    let app = AppView::new(wrapper.mtm(), NSRect::ZERO, SurfaceOptions::default());
    app.set_error_handler(|message| tracing::error!(%message, "iOS remote desktop controls"));
    let hosted = app.view();
    hosted.setFrame(wrapper.bounds());
    hosted.setAutoresizingMask(
        UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
    );
    hosted.setOpaque(false);
    hosted.setBackgroundColor(Some(&UIColor::clearColor()));
    wrapper.addSubview(hosted);
    app.run(controls_root(bridge));
    Box::into_raw(Box::new(Controls { app, overlay }))
}

/// # Safety
/// All operations borrow the live owner on the UIKit main thread. Swift keeps
/// the NUL-terminated state snapshot alive for this call.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_controls_update(controls: &Controls, json: *const c_char) {
    // SAFETY: The caller uses withCString for the entire call.
    let bytes = unsafe { CStr::from_ptr(json).to_bytes() };
    match serde_json::from_slice::<ToolbarState>(bytes) {
        Ok(input) => controls
            .overlay
            .lock()
            .expect("viewer layout lock")
            .update(input, [0.; 4]),
        Err(error) => tracing::warn!(%error, "invalid iOS controls state"),
    }
}

/// # Safety
/// Swift borrows the live owner on the main thread.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_controls_drag(controls: &Controls, dx: f32, dy: f32) {
    controls
        .overlay
        .lock()
        .expect("viewer layout lock")
        .drag(dx, dy);
}

/// # Safety
/// Swift borrows the live owner on the main thread, with coordinates local to its wrapper.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_controls_hit(
    controls: &Controls,
    x: f32,
    y: f32,
    grip: bool,
) -> bool {
    controls
        .overlay
        .lock()
        .expect("viewer layout lock")
        .hit(x, y, grip)
}

/// # Safety
/// Swift borrows the live owner on the main thread.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_controls_owns_focus(controls: &Controls) -> bool {
    controls
        .overlay
        .lock()
        .expect("viewer layout lock")
        .owns_focus()
}

/// # Safety
/// The main-thread wrapper transfers its owner back exactly once.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_controls_destroy(handle: *mut Controls) {
    debug_assert!(MainThreadMarker::new().is_some());
    // SAFETY: This consumes the Box returned by create.
    let controls = unsafe { Box::from_raw(handle) };
    controls.app.view().removeFromSuperview();
}
