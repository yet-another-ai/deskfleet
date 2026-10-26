use std::ffi::c_void;

use crate::CaptureError;

pub(crate) type PlatformInner = Vec<u8>;

pub(crate) fn as_raw_ptr(inner: &PlatformInner) -> *const c_void {
    inner.as_ptr().cast()
}

pub(crate) fn copy_pixels(inner: &PlatformInner) -> Result<Vec<u8>, CaptureError> {
    Ok(inner.clone())
}
