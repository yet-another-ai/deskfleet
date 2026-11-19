//! macOS general pasteboard access for remote desktop clipboard sharing.

#![allow(unsafe_code)]

use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::NSString;

use crate::{InputError, MAX_CLIPBOARD_BYTES, Result};

const PASTEBOARD_TYPE_UTF8: &str = "public.utf8-plain-text";

#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {}

pub(super) struct MacOsClipboard {
    change_count: isize,
}

impl MacOsClipboard {
    pub(super) fn new() -> Self {
        let change_count = general_pasteboard()
            .map(|pb| change_count(&pb))
            .unwrap_or(0);
        Self { change_count }
    }

    pub(super) fn set_text(&mut self, text: &str) -> Result<()> {
        let pb = general_pasteboard()
            .ok_or_else(|| InputError::Platform("NSPasteboard is unavailable".into()))?;
        let clean = text.replace('\0', " ");
        let ns_text = NSString::from_str(&clean);
        let pb_type = NSString::from_str(PASTEBOARD_TYPE_UTF8);
        // SAFETY: `clearContents` and `setString:forType:` are standard NSPasteboard methods
        // taking valid NSString references.
        let ok: bool = unsafe {
            let _: isize = msg_send![&pb, clearContents];
            msg_send![&pb, setString: &*ns_text, forType: &*pb_type]
        };
        self.change_count = change_count(&pb);
        if !ok {
            return Err(InputError::Platform(
                "failed to write string to NSPasteboard".into(),
            ));
        }
        Ok(())
    }

    pub(super) fn poll_text(&mut self) -> Result<Option<String>> {
        let Some(pb) = general_pasteboard() else {
            return Ok(None);
        };
        let current = change_count(&pb);
        if current == self.change_count {
            return Ok(None);
        }
        self.change_count = current;
        let pb_type = NSString::from_str(PASTEBOARD_TYPE_UTF8);
        // SAFETY: `stringForType:` returns an optional NSString from NSPasteboard.
        let value: Option<Retained<NSString>> = unsafe { msg_send![&pb, stringForType: &*pb_type] };
        let Some(value) = value else {
            return Ok(None);
        };
        let text = value.to_string().replace("\r\n", "\n");
        if text.is_empty() || text.len() > MAX_CLIPBOARD_BYTES {
            return Ok(None);
        }
        Ok(Some(text))
    }
}

fn general_pasteboard() -> Option<Retained<AnyObject>> {
    // SAFETY: `NSPasteboard.generalPasteboard` is thread-safe and returns a shared pasteboard instance.
    unsafe { msg_send![class!(NSPasteboard), generalPasteboard] }
}

fn change_count(pasteboard: &AnyObject) -> isize {
    // SAFETY: `changeCount` returns the monotonic NSInteger modification counter.
    unsafe { msg_send![pasteboard, changeCount] }
}
