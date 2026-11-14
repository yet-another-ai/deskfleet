//! C-ABI surface for Kotlin/Native (`iosArm64`, `iosSimulatorArm64`) cinterop.

use std::ffi::{CStr, CString, c_char};
use std::ptr;

use crate::{
    accept_answer, add_ice_candidate, answer_offer, close_peer, create_data_channel, create_offer,
    create_peer, open_local_network_settings, poll_event_json, request_local_network, run_nat_test,
    send_bytes, send_text, set_error, snapshot_video_frame, take_last_error,
};

fn cstr_to_str<'a>(ptr: *const c_char) -> Result<&'a str, String> {
    if ptr.is_null() {
        return Err("null C string pointer".to_owned());
    }
    // SAFETY: Caller guarantees valid NUL-terminated string for the duration of the call.
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .map_err(|e| format!("invalid UTF-8 string: {e}"))
}

fn into_cstring_ptr(text: String) -> *mut c_char {
    match CString::new(text) {
        Ok(cs) => cs.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_last_error() -> *mut c_char {
    match take_last_error() {
        Some(err) => into_cstring_ptr(err),
        None => ptr::null_mut(),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_string_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        // SAFETY: Pointer was allocated by CString::into_raw in this library.
        unsafe {
            drop(CString::from_raw(ptr));
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_peer_create(config_json: *const c_char) -> u64 {
    let result = cstr_to_str(config_json).and_then(create_peer);
    match result {
        Ok(handle) => handle,
        Err(err) => {
            set_error(err);
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_peer_create_data_channel(
    handle: u64,
    label: *const c_char,
) -> bool {
    match cstr_to_str(label).and_then(|lbl| create_data_channel(handle, lbl)) {
        Ok(()) => true,
        Err(err) => {
            set_error(err);
            false
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_peer_create_offer(handle: u64) -> *mut c_char {
    match create_offer(handle) {
        Ok(sdp) => into_cstring_ptr(sdp),
        Err(err) => {
            set_error(err);
            ptr::null_mut()
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_peer_answer_offer(
    handle: u64,
    sdp: *const c_char,
) -> *mut c_char {
    match cstr_to_str(sdp).and_then(|offer| answer_offer(handle, offer)) {
        Ok(answer) => into_cstring_ptr(answer),
        Err(err) => {
            set_error(err);
            ptr::null_mut()
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_peer_accept_answer(handle: u64, sdp: *const c_char) -> bool {
    match cstr_to_str(sdp).and_then(|ans| accept_answer(handle, ans)) {
        Ok(()) => true,
        Err(err) => {
            set_error(err);
            false
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_peer_add_ice_candidate(
    handle: u64,
    candidate_json: *const c_char,
) -> bool {
    match cstr_to_str(candidate_json).and_then(|cand| add_ice_candidate(handle, cand)) {
        Ok(()) => true,
        Err(err) => {
            set_error(err);
            false
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_peer_send_bytes(
    handle: u64,
    label: *const c_char,
    data: *const u8,
    len: usize,
) -> bool {
    let slice = if len == 0 {
        &[][..]
    } else if data.is_null() {
        set_error("null data pointer");
        return false;
    } else {
        // SAFETY: Caller supplies a valid buffer of `len` bytes for this call.
        unsafe { std::slice::from_raw_parts(data, len) }
    };
    match cstr_to_str(label).and_then(|lbl| send_bytes(handle, lbl, slice)) {
        Ok(()) => true,
        Err(err) => {
            set_error(err);
            false
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_peer_send_text(
    handle: u64,
    label: *const c_char,
    text: *const c_char,
) -> bool {
    let outcome = cstr_to_str(label)
        .and_then(|lbl| cstr_to_str(text).and_then(|txt| send_text(handle, lbl, txt)));
    match outcome {
        Ok(()) => true,
        Err(err) => {
            set_error(err);
            false
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_peer_poll_event(handle: u64, timeout_ms: u64) -> *mut c_char {
    match poll_event_json(handle, timeout_ms) {
        Ok(Some(json)) => into_cstring_ptr(json),
        Ok(None) => ptr::null_mut(),
        Err(err) => {
            set_error(err);
            ptr::null_mut()
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_peer_copy_video_frame(
    handle: u64,
    after_seq: u64,
    out_bgra: *mut u8,
    out_capacity: usize,
    out_width: *mut u32,
    out_height: *mut u32,
    out_seq: *mut u64,
) -> i32 {
    let Some(frame) = snapshot_video_frame(handle, after_seq) else {
        return 0;
    };
    if !out_width.is_null() {
        // SAFETY: Caller supplied valid output pointer.
        unsafe { *out_width = frame.width };
    }
    if !out_height.is_null() {
        // SAFETY: Caller supplied valid output pointer.
        unsafe { *out_height = frame.height };
    }
    if !out_seq.is_null() {
        // SAFETY: Caller supplied valid output pointer.
        unsafe { *out_seq = frame.seq };
    }
    let needed = frame.bgra.len();
    if out_bgra.is_null() || out_capacity < needed {
        return -1;
    }
    // SAFETY: `out_bgra` has at least `needed` writable bytes.
    unsafe {
        ptr::copy_nonoverlapping(frame.bgra.as_ptr(), out_bgra, needed);
    }
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_peer_close(handle: u64) {
    close_peer(handle);
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_test_nat(server: *const c_char) -> *mut c_char {
    match cstr_to_str(server).and_then(run_nat_test) {
        Ok(json) => into_cstring_ptr(json),
        Err(err) => {
            set_error(err);
            ptr::null_mut()
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_request_local_network() -> *mut c_char {
    match request_local_network() {
        Ok(status) => into_cstring_ptr(status.to_owned()),
        Err(err) => {
            set_error(err);
            ptr::null_mut()
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_kmp_open_local_network_settings() -> bool {
    match open_local_network_settings() {
        Ok(()) => true,
        Err(err) => {
            set_error(err);
            false
        }
    }
}
