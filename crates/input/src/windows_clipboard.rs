//! Win32 clipboard access for the active input desktop.

#![allow(unsafe_code)]

use std::ptr::copy_nonoverlapping;
use std::thread::sleep;
use std::time::Duration;

use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
    IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
};
use windows::Win32::System::Ole::CF_UNICODETEXT;

use crate::{InputError, MAX_CLIPBOARD_BYTES, Result};

const UNICODE_FORMAT: u32 = CF_UNICODETEXT.0 as u32;
const OPEN_ATTEMPTS: usize = 5;
const OPEN_RETRY_DELAY: Duration = Duration::from_millis(2);

pub(super) struct WindowsClipboard {
    sequence: u32,
}

impl WindowsClipboard {
    pub(super) fn new() -> Self {
        Self {
            // SAFETY: Reads the current window station's clipboard sequence counter.
            sequence: unsafe { GetClipboardSequenceNumber() },
        }
    }

    pub(super) fn reset_sequence(&mut self) {
        // SAFETY: Reads the current window station's clipboard sequence counter.
        self.sequence = unsafe { GetClipboardSequenceNumber() };
    }

    pub(super) fn set_text(&mut self, text: &str) -> Result<()> {
        let wide = encode_utf16_crlf(text);
        let byte_len = wide
            .len()
            .checked_mul(size_of::<u16>())
            .ok_or(InputError::InvalidEvent("clipboard text is too large"))?;
        let _guard = ClipboardGuard::open()?;
        // SAFETY: The current thread owns the open clipboard through `_guard`.
        unsafe { EmptyClipboard() }
            .map_err(|error| InputError::Platform(format!("clear clipboard: {error}")))?;
        // SAFETY: Allocates moveable global memory sized for the UTF-16 buffer.
        let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, byte_len) }
            .map_err(|error| InputError::Platform(format!("allocate clipboard memory: {error}")))?;
        {
            let locked = LockedMemory::lock(memory)?;
            // SAFETY: `locked.ptr` points to `byte_len` writable bytes and `wide` has `wide.len()` u16 elements.
            unsafe {
                copy_nonoverlapping(wide.as_ptr(), locked.ptr.cast::<u16>(), wide.len());
            }
        }
        // SAFETY: Transfers ownership of `memory` to the open clipboard on success.
        if let Err(error) = unsafe { SetClipboardData(UNICODE_FORMAT, Some(HANDLE(memory.0))) } {
            // SAFETY: `SetClipboardData` failed, so we still own `memory` and must free it.
            let _ = unsafe { GlobalFree(Some(memory)) };
            return Err(InputError::Platform(format!(
                "write clipboard text: {error}"
            )));
        }
        drop(_guard);
        self.reset_sequence();
        Ok(())
    }

    pub(super) fn poll_text(&mut self) -> Result<Option<String>> {
        // SAFETY: Reads the current window station's clipboard sequence counter.
        let current = unsafe { GetClipboardSequenceNumber() };
        if current == 0 || current == self.sequence {
            return Ok(None);
        }
        // SAFETY: Checks whether the clipboard currently offers UTF-16 text.
        if unsafe { IsClipboardFormatAvailable(UNICODE_FORMAT) }.is_err() {
            self.sequence = current;
            return Ok(None);
        }
        let Ok(_guard) = ClipboardGuard::open() else {
            // Another process briefly holds the clipboard; retry on the next poll.
            return Ok(None);
        };
        // SAFETY: Reads the sequence number while holding the clipboard lock.
        self.sequence = unsafe { GetClipboardSequenceNumber() };
        // SAFETY: The clipboard is open on this thread and format availability was checked.
        let Ok(handle) = (unsafe { GetClipboardData(UNICODE_FORMAT) }) else {
            return Ok(None);
        };
        let global = HGLOBAL(handle.0);
        // SAFETY: Queries the byte size of the clipboard's global memory block.
        let byte_size = unsafe { GlobalSize(global) };
        let word_len = byte_size / size_of::<u16>();
        if word_len == 0 || word_len > MAX_CLIPBOARD_BYTES * 2 + 1 {
            return Ok(None);
        }
        let Ok(locked) = LockedMemory::lock(global) else {
            return Ok(None);
        };
        // SAFETY: `locked.ptr` is valid for `word_len` u16 values while `locked` is alive.
        let units = unsafe { std::slice::from_raw_parts(locked.ptr.cast::<u16>(), word_len) };
        let text = decode_utf16_lf(units);
        if text.is_empty() || text.len() > MAX_CLIPBOARD_BYTES {
            return Ok(None);
        }
        Ok(Some(text))
    }
}

struct ClipboardGuard;

impl ClipboardGuard {
    fn open() -> Result<Self> {
        let mut last_error = None;
        for attempt in 0..OPEN_ATTEMPTS {
            // SAFETY: Opens the clipboard for the current thread without a window handle.
            match unsafe { OpenClipboard(None) } {
                Ok(()) => return Ok(Self),
                Err(error) => {
                    last_error = Some(error);
                    if attempt + 1 < OPEN_ATTEMPTS {
                        sleep(OPEN_RETRY_DELAY);
                    }
                }
            }
        }
        Err(InputError::Platform(format!(
            "open clipboard: {}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_default()
        )))
    }
}

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        // SAFETY: Closes the clipboard opened by `ClipboardGuard::open` on this thread.
        let _ = unsafe { CloseClipboard() };
    }
}

struct LockedMemory {
    global: HGLOBAL,
    ptr: *mut std::ffi::c_void,
}

impl LockedMemory {
    fn lock(global: HGLOBAL) -> Result<Self> {
        // SAFETY: Locks a live HGLOBAL handle before accessing its bytes.
        let ptr = unsafe { GlobalLock(global) };
        if ptr.is_null() {
            return Err(InputError::Platform(format!(
                "lock clipboard memory: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(Self { global, ptr })
    }
}

impl Drop for LockedMemory {
    fn drop(&mut self) {
        // SAFETY: Balances the successful `GlobalLock` in `LockedMemory::lock`.
        let _ = unsafe { GlobalUnlock(self.global) };
    }
}

fn encode_utf16_crlf(text: &str) -> Vec<u16> {
    let mut wide = Vec::with_capacity(text.len() + 1);
    let mut previous_cr = false;
    for ch in text.chars() {
        let ch = if ch == '\0' { ' ' } else { ch };
        if ch == '\n' && !previous_cr {
            wide.push(u16::from(b'\r'));
        }
        previous_cr = ch == '\r';
        let mut buf = [0u16; 2];
        wide.extend_from_slice(ch.encode_utf16(&mut buf));
    }
    wide.push(0);
    wide
}

fn decode_utf16_lf(units: &[u16]) -> String {
    let end = units
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end]).replace("\r\n", "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_conversion_normalizes_line_endings_and_embedded_nuls() {
        let encoded = encode_utf16_crlf("line1\nline2\r\nline3\0tail");
        assert_eq!(encoded.last().copied(), Some(0));
        let raw = String::from_utf16(&encoded[..encoded.len() - 1]).unwrap();
        assert_eq!(raw, "line1\r\nline2\r\nline3 tail");
        assert_eq!(decode_utf16_lf(&encoded), "line1\nline2\nline3 tail");
    }
}
