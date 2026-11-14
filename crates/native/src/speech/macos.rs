//! Objective-C owns AVFoundation objects on the main queue; Rust owns event delivery.
#![allow(unsafe_code)] // The narrow native bridge requires raw handles and callbacks.

use std::ffi::{CStr, CString, c_char, c_void};

use super::{EventSink, SpeechEventKind};

type Callback = extern "C" fn(*mut c_void, u32, *const c_char, bool, f64);

unsafe extern "C" {
    fn df_speech_supported(locale: *const c_char) -> bool;
    fn df_speech_create(
        locale: *const c_char,
        context: *mut c_void,
        callback: Callback,
        release: extern "C" fn(*mut c_void),
    ) -> *mut c_void;
    fn df_speech_stop(controller: *mut c_void);
    fn df_speech_cancel(controller: *mut c_void);
    fn df_speech_release(controller: *mut c_void);
}

pub(super) fn supported(locale: &str) -> bool {
    let Ok(locale) = CString::new(locale) else {
        return false;
    };
    // SAFETY: the bridge copies/uses this terminated string before returning.
    unsafe { df_speech_supported(locale.as_ptr()) }
}

pub(super) struct Controller(*mut c_void);

// SAFETY: this is an opaque retained Objective-C handle. Every bridge operation
// dispatches object access to the main queue; Rust never dereferences the handle.
unsafe impl Send for Controller {}
// SAFETY: bridge operations may be invoked concurrently and serialize on main.
unsafe impl Sync for Controller {}

impl Controller {
    pub(super) fn start(locale: String, sink: EventSink) -> std::io::Result<Self> {
        let locale = CString::new(locale).map_err(std::io::Error::other)?;
        let context = Box::into_raw(Box::new(sink)).cast();
        // SAFETY: the bridge takes ownership of context, calls release exactly
        // once on object destruction, and copies locale before returning.
        let pointer = unsafe { df_speech_create(locale.as_ptr(), context, event, release) };
        Ok(Self(pointer))
    }

    pub(super) fn stop(&self) {
        // SAFETY: self owns the retained bridge handle until Drop.
        unsafe { df_speech_stop(self.0) }
    }

    pub(super) fn cancel(&self) {
        // SAFETY: self owns the retained bridge handle until Drop.
        unsafe { df_speech_cancel(self.0) }
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        // SAFETY: consumes this object's sole retained bridge handle exactly once.
        unsafe { df_speech_release(self.0) }
    }
}

extern "C" fn release(context: *mut c_void) {
    // SAFETY: context was Box::into_raw above and is released only by bridge dealloc.
    drop(unsafe { Box::from_raw(context.cast::<EventSink>()) });
}

extern "C" fn event(
    context: *mut c_void,
    kind: u32,
    text: *const c_char,
    final_: bool,
    level: f64,
) {
    // SAFETY: the bridge retains context during this synchronous callback.
    let sink = unsafe { &*context.cast::<EventSink>() };
    let text = if text.is_null() {
        String::new()
    } else {
        // SAFETY: text points to an NSString's UTF8String valid for this callback.
        unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned()
    };
    let kind = match kind {
        0 => SpeechEventKind::Started,
        1 => SpeechEventKind::Result {
            text,
            is_final: final_,
        },
        2 => SpeechEventKind::Level(level.clamp(0.0, 1.0)),
        3 => SpeechEventKind::Ended,
        4..=8 => SpeechEventKind::Error {
            code: match kind {
                4 => "permission-denied",
                5 => "unavailable",
                6 => "no-speech",
                7 => "network",
                _ => "failed",
            },
            message: text,
        },
        _ => return,
    };
    sink.emit(kind);
}
