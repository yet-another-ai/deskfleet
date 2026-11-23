//! Main-thread bridge between UIKit and the shared control policy.
#![allow(unsafe_code)]

use std::ffi::{CStr, CString, c_char};

/// # Safety
/// UIKit lends two NUL-terminated UTF-8 strings for this synchronous call.
/// The caller frees the returned string with deskfleet_ios_control_effects_free.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_control_effects(
    state: *const c_char,
    action: *const c_char,
) -> *mut c_char {
    // SAFETY: Swift supplies both strings through nested withCString calls.
    let (state, action) = unsafe { (CStr::from_ptr(state), CStr::from_ptr(action)) };
    let (Ok(state), Ok(action)) = (state.to_str(), action.to_str()) else {
        return std::ptr::null_mut();
    };
    match deskfleet_viewer_controls::effects_json(state, action) {
        Ok(json) => CString::new(json).expect("JSON escapes NUL").into_raw(),
        Err(error) => {
            tracing::warn!(%error, "invalid iOS control transition");
            std::ptr::null_mut()
        }
    }
}

/// # Safety
/// Swift transfers one non-null result from deskfleet_ios_control_effects exactly once.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_control_effects_free(json: *mut c_char) {
    // SAFETY: This is the allocation transferred by CString::into_raw above.
    drop(unsafe { CString::from_raw(json) });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swift_receives_an_owned_list_of_effects_or_null_on_invalid_input() {
        let state =
            cr#"{"mobile":true,"ui":{"status":"connected","control":true,"inputReady":true}}"#;
        let action = cr#"{"type":"toggleControl"}"#;
        // SAFETY: Both input C strings remain live, and the result is freed once.
        unsafe {
            let result = deskfleet_ios_control_effects(state.as_ptr(), action.as_ptr());
            assert!(!result.is_null());
            let effects: serde_json::Value =
                serde_json::from_slice(CStr::from_ptr(result).to_bytes()).unwrap();
            assert_eq!(
                effects[1],
                serde_json::json!({"type":"paused","value":true})
            );
            deskfleet_ios_control_effects_free(result);
            assert!(deskfleet_ios_control_effects(state.as_ptr(), c"{}".as_ptr()).is_null());
        }
    }
}
