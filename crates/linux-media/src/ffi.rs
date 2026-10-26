//! The small GStreamer 1.x C ABI surface needed by our pipelines.
//!
//! Public layouts follow gstminiobject.h, gstbuffer.h, gstvideometa.h and
//! glib/gerror.h. All other objects are opaque. Libraries remain loaded for the
//! process lifetime because GStreamer registers global GTypes and plugin code.

#![allow(unsafe_code)]

use std::ffi::{CStr, CString, c_char, c_int, c_uint, c_void};
use std::sync::OnceLock;

use libloading::Library;

use crate::{Error, Result};

pub(crate) type Object = c_void;
pub(crate) const CLOCK_TIME_NONE: u64 = u64::MAX;
pub(crate) const STATE_NULL: c_int = 1;
pub(crate) const STATE_PLAYING: c_int = 4;
pub(crate) const MESSAGE_ERROR: c_uint = 1 << 1;
pub(crate) const BUFFER_DELTA_UNIT: c_uint = 1 << 13;

#[repr(C)]
pub(crate) struct MiniObject {
    type_: usize,
    refcount: c_int,
    lockstate: c_int,
    pub flags: c_uint,
    copy: Option<unsafe extern "C" fn(*const MiniObject) -> *mut MiniObject>,
    dispose: Option<unsafe extern "C" fn(*mut MiniObject) -> c_int>,
    free: Option<unsafe extern "C" fn(*mut MiniObject)>,
    priv_uint: c_uint,
    priv_pointer: *mut c_void,
}

#[repr(C)]
pub(crate) struct Buffer {
    pub mini_object: MiniObject,
    pool: *mut Object,
    pub pts: u64,
    pub dts: u64,
    pub duration: u64,
    offset: u64,
    offset_end: u64,
}

#[repr(C)]
pub(crate) struct GError {
    domain: u32,
    code: c_int,
    message: *mut c_char,
}

#[repr(C)]
struct Meta {
    flags: c_uint,
    info: *const Object,
}

/// Only the public prefix through stride is accessed; no allocation of this type.
#[repr(C)]
pub(crate) struct VideoMeta {
    meta: Meta,
    buffer: *mut Buffer,
    flags: c_int,
    format: c_int,
    id: c_int,
    pub width: c_uint,
    pub height: c_uint,
    pub n_planes: c_uint,
    pub offset: [usize; 4],
    pub stride: [c_int; 4],
}

macro_rules! api {
    ($core:ident, $app:ident, $video:ident, $glib:ident; $($field:ident: $ty:ty = $lib:ident :: $symbol:literal),+ $(,)?) => {
        pub(crate) struct Api {
            $(pub $field: $ty,)+
            _libraries: [Library; 4],
        }

        impl Api {
            fn load() -> std::result::Result<Self, String> {
                // SAFETY: These are system GStreamer 1.x / GLib libraries. Native
                // initialization is their documented public loading contract.
                let ($core, $app, $video, $glib) = unsafe {
                    (
                        Library::new("libgstreamer-1.0.so.0"),
                        Library::new("libgstapp-1.0.so.0"),
                        Library::new("libgstvideo-1.0.so.0"),
                        Library::new("libglib-2.0.so.0"),
                    )
                };
                let $core = $core.map_err(|e| e.to_string())?;
                let $app = $app.map_err(|e| e.to_string())?;
                let $video = $video.map_err(|e| e.to_string())?;
                let $glib = $glib.map_err(|e| e.to_string())?;
                let api = Self {
                    $(
                        // SAFETY: Symbol names and function signatures match the
                        // stable GStreamer 1.x C ABI. Libraries are retained below.
                        $field: unsafe { *$lib.get::<$ty>(concat!($symbol, "\0").as_bytes())
                            .map_err(|e| e.to_string())? },
                    )+
                    _libraries: [$core, $app, $video, $glib],
                };
                let mut error = std::ptr::null_mut();
                // SAFETY: Null argc/argv are explicitly supported. Error points
                // to initialized storage and is released through GLib below.
                let initialized = unsafe {
                    (api.init_check)(std::ptr::null_mut(), std::ptr::null_mut(), &raw mut error)
                };
                if initialized == 0 {
                    return Err(api.take_error(error));
                }
                Ok(api)
            }
        }
    };
}

api! {
    core, app, video, glib;
    init_check: unsafe extern "C" fn(*mut c_int, *mut *mut *mut c_char, *mut *mut GError) -> c_int = core::"gst_init_check",
    parse_launch: unsafe extern "C" fn(*const c_char, *mut *mut GError) -> *mut Object = core::"gst_parse_launch",
    object_unref: unsafe extern "C" fn(*mut Object) = core::"gst_object_unref",
    mini_unref: unsafe extern "C" fn(*mut MiniObject) = core::"gst_mini_object_unref",
    bin_get_by_name: unsafe extern "C" fn(*mut Object, *const c_char) -> *mut Object = core::"gst_bin_get_by_name",
    element_set_state: unsafe extern "C" fn(*mut Object, c_int) -> c_int = core::"gst_element_set_state",
    element_get_bus: unsafe extern "C" fn(*mut Object) -> *mut Object = core::"gst_element_get_bus",
    bus_pop_filtered: unsafe extern "C" fn(*mut Object, c_uint) -> *mut Object = core::"gst_bus_pop_filtered",
    message_parse_error: unsafe extern "C" fn(*mut Object, *mut *mut GError, *mut *mut c_char) = core::"gst_message_parse_error",
    factory_find: unsafe extern "C" fn(*const c_char) -> *mut Object = core::"gst_element_factory_find",
    sample_get_buffer: unsafe extern "C" fn(*mut Object) -> *mut Buffer = core::"gst_sample_get_buffer",
    sample_get_caps: unsafe extern "C" fn(*mut Object) -> *mut Object = core::"gst_sample_get_caps",
    caps_get_structure: unsafe extern "C" fn(*const Object, c_uint) -> *const Object = core::"gst_caps_get_structure",
    structure_get_int: unsafe extern "C" fn(*const Object, *const c_char, *mut c_int) -> c_int = core::"gst_structure_get_int",
    buffer_get_size: unsafe extern "C" fn(*mut Buffer) -> usize = core::"gst_buffer_get_size",
    buffer_extract: unsafe extern "C" fn(*mut Buffer, usize, *mut c_void, usize) -> usize = core::"gst_buffer_extract",
    buffer_new_allocate: unsafe extern "C" fn(*mut Object, usize, *mut Object) -> *mut Buffer = core::"gst_buffer_new_allocate",
    buffer_fill: unsafe extern "C" fn(*mut Buffer, usize, *const c_void, usize) -> usize = core::"gst_buffer_fill",
    util_set_object_arg: unsafe extern "C" fn(*mut Object, *const c_char, *const c_char) = core::"gst_util_set_object_arg",
    element_send_event: unsafe extern "C" fn(*mut Object, *mut Object) -> c_int = core::"gst_element_send_event",
    sink_try_pull_sample: unsafe extern "C" fn(*mut Object, u64) -> *mut Object = app::"gst_app_sink_try_pull_sample",
    sink_is_eos: unsafe extern "C" fn(*mut Object) -> c_int = app::"gst_app_sink_is_eos",
    source_push_buffer: unsafe extern "C" fn(*mut Object, *mut Buffer) -> c_int = app::"gst_app_src_push_buffer",
    source_end_of_stream: unsafe extern "C" fn(*mut Object) -> c_int = app::"gst_app_src_end_of_stream",
    buffer_get_video_meta: unsafe extern "C" fn(*mut Buffer) -> *mut VideoMeta = video::"gst_buffer_get_video_meta",
    force_key_unit: unsafe extern "C" fn(u64, c_int, c_uint) -> *mut Object = video::"gst_video_event_new_upstream_force_key_unit",
    error_free: unsafe extern "C" fn(*mut GError) = glib::"g_error_free",
    free: unsafe extern "C" fn(*mut c_void) = glib::"g_free",
}

impl Api {
    pub fn has_factory(&self, name: &str) -> bool {
        let Ok(name) = CString::new(name) else {
            return false;
        };
        // SAFETY: CString is valid for this call; find returns an owned GstObject.
        let factory = unsafe { (self.factory_find)(name.as_ptr()) };
        if factory.is_null() {
            return false;
        }
        // SAFETY: factory is the owned non-null reference returned above.
        unsafe { (self.object_unref)(factory) };
        true
    }

    pub fn take_error(&self, error: *mut GError) -> String {
        if error.is_null() {
            return "GStreamer operation failed".into();
        }
        // SAFETY: This private helper receives a GError returned by GStreamer;
        // its message is NUL-terminated and valid until g_error_free below.
        let message = unsafe { CStr::from_ptr((*error).message) }
            .to_string_lossy()
            .into_owned();
        // SAFETY: Consume the GError ownership transferred by the failed call.
        unsafe { (self.error_free)(error) };
        message
    }
}

pub(crate) fn api() -> Result<&'static Api> {
    static API: OnceLock<std::result::Result<Api, String>> = OnceLock::new();
    API.get_or_init(Api::load)
        .as_ref()
        .map_err(|e| Error::Unavailable(e.clone()))
}
