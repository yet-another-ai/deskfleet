//! RAII ownership around the dynamically loaded C API.

#![allow(unsafe_code)]

use std::cell::Cell;
use std::ffi::{CStr, CString};
use std::ptr::NonNull;
use std::time::Duration;

use crate::ffi::{self, Api};
use crate::{Error, Result};

pub(crate) struct Object {
    pub ptr: NonNull<ffi::Object>,
    pub api: &'static Api,
}

impl Drop for Object {
    fn drop(&mut self) {
        // SAFETY: Each Object owns one reference; the library outlives it.
        unsafe { (self.api.object_unref)(self.ptr.as_ptr()) };
    }
}

pub(crate) struct Pipeline {
    pub element: Object,
    sink: Object,
    bus: Object,
    stopped: Cell<bool>,
}

impl Pipeline {
    pub fn new(description: &str) -> Result<Self> {
        let api = ffi::api()?;
        let text = CString::new(description)
            .map_err(|_| Error::Pipeline("invalid pipeline description".into()))?;
        let mut error = std::ptr::null_mut();
        // SAFETY: text and error storage are valid for the call. The result and
        // error transfer ownership, including partial pipelines on parse errors.
        let ptr = unsafe { (api.parse_launch)(text.as_ptr(), &raw mut error) };
        let element = NonNull::new(ptr).map(|ptr| Object { ptr, api });
        if !error.is_null() {
            return Err(Error::Pipeline(api.take_error(error)));
        }
        let element = element.ok_or_else(|| Error::Pipeline("empty pipeline".into()))?;
        let sink = Self::find(&element, c"frames")?;
        // SAFETY: element is a live pipeline; get_bus returns an owned reference.
        let bus = unsafe { (api.element_get_bus)(element.ptr.as_ptr()) };
        let bus = Object {
            ptr: NonNull::new(bus).ok_or_else(|| Error::Pipeline("pipeline has no bus".into()))?,
            api,
        };
        let pipeline = Self {
            element,
            sink,
            bus,
            stopped: Cell::new(false),
        };
        // SAFETY: Pipeline retains the element for the entire call.
        if unsafe { (api.element_set_state)(pipeline.element.ptr.as_ptr(), ffi::STATE_PLAYING) }
            == 0
        {
            pipeline.check_error()?;
            return Err(Error::Pipeline("cannot start pipeline".into()));
        }
        Ok(pipeline)
    }

    fn find(element: &Object, name: &CStr) -> Result<Object> {
        // SAFETY: element is a GstBin; name is NUL-terminated. Return is owned.
        let ptr = unsafe { (element.api.bin_get_by_name)(element.ptr.as_ptr(), name.as_ptr()) };
        Ok(Object {
            ptr: NonNull::new(ptr).ok_or_else(|| {
                Error::Pipeline(format!("missing element {}", name.to_string_lossy()))
            })?,
            api: element.api,
        })
    }

    pub fn child(&self, name: &CStr) -> Result<Object> {
        Self::find(&self.element, name)
    }

    pub fn check_error(&self) -> Result<()> {
        let api = self.element.api;
        // SAFETY: bus is a live GstBus. Only ERROR messages are requested.
        let message = unsafe { (api.bus_pop_filtered)(self.bus.ptr.as_ptr(), ffi::MESSAGE_ERROR) };
        if message.is_null() {
            return Ok(());
        }
        let mut error = std::ptr::null_mut();
        let mut debug = std::ptr::null_mut();
        // SAFETY: message is an ERROR message; both out pointers are initialized.
        unsafe { (api.message_parse_error)(message, &raw mut error, &raw mut debug) };
        let text = api.take_error(error);
        // SAFETY: debug is GLib-allocated or null; message ownership came from pop.
        unsafe {
            (api.free)(debug.cast());
            (api.mini_unref)(message.cast());
        }
        Err(Error::Pipeline(text))
    }

    /// Check a previously started stream without consuming its queued sample.
    ///
    /// EOS alone is not drained: with `wait-on-eos=false`, the appsink may still
    /// hold its single queued buffer after `gst_app_sink_is_eos` becomes true.
    /// Pacing must leave that last damage until the frame is due; `pull` reports
    /// [`Error::Ended`] only after the queue is empty.
    pub fn check_active(&self) -> Result<()> {
        if self.stopped.get() {
            return Err(Error::Ended);
        }
        self.check_error()
    }

    pub fn pull(&self, timeout: Duration) -> Result<Option<Sample>> {
        if self.stopped.get() {
            return Err(Error::Ended);
        }
        self.check_error()?;
        let api = self.element.api;
        let timeout = u64::try_from(timeout.as_nanos()).unwrap_or(u64::MAX - 1);
        // SAFETY: sink is the named appsink retained by this pipeline.
        let sample = unsafe { (api.sink_try_pull_sample)(self.sink.ptr.as_ptr(), timeout) };
        self.check_error().inspect_err(|_| {
            if !sample.is_null() {
                // SAFETY: The pull returned an owned sample, discarded on error.
                unsafe { (api.mini_unref)(sample.cast()) };
            }
        })?;
        if let Some(ptr) = NonNull::new(sample) {
            return Ok(Some(Sample { ptr, api }));
        }
        // SAFETY: sink remains alive and is an appsink.
        if unsafe { (api.sink_is_eos)(self.sink.ptr.as_ptr()) } != 0 {
            return Err(Error::Ended);
        }
        Ok(None)
    }

    pub fn stop(&self) -> Result<()> {
        if self.stopped.replace(true) {
            return Ok(());
        }
        // SAFETY: Moving the live pipeline to NULL joins its streaming tasks.
        if unsafe {
            (self.element.api.element_set_state)(self.element.ptr.as_ptr(), ffi::STATE_NULL)
        } == 0
        {
            return Err(Error::Pipeline("cannot stop pipeline".into()));
        }
        Ok(())
    }
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            tracing::warn!(%error, "Linux media pipeline cleanup failed");
        }
    }
}

pub(crate) struct Sample {
    ptr: NonNull<ffi::Object>,
    api: &'static Api,
}

impl Sample {
    fn buffer(&self) -> Result<NonNull<ffi::Buffer>> {
        // SAFETY: sample is alive; its buffer is borrowed until sample unref.
        NonNull::new(unsafe { (self.api.sample_get_buffer)(self.ptr.as_ptr()) })
            .ok_or_else(|| Error::Pipeline("sample has no buffer".into()))
    }

    pub fn bytes(&self) -> Result<Vec<u8>> {
        let buffer = self.buffer()?;
        // SAFETY: sample owns the buffer throughout size/extract.
        let size = unsafe { (self.api.buffer_get_size)(buffer.as_ptr()) };
        let mut bytes = vec![0; size];
        // SAFETY: bytes has exactly size writable bytes; extract handles mapping.
        let copied = unsafe {
            (self.api.buffer_extract)(buffer.as_ptr(), 0, bytes.as_mut_ptr().cast(), size)
        };
        if copied != size {
            return Err(Error::Pipeline("cannot read sample memory".into()));
        }
        Ok(bytes)
    }

    pub fn timing(&self) -> Result<(u64, u64, bool)> {
        let buffer = self.buffer()?;
        // SAFETY: These are public fields of GstBuffer's stable 1.x ABI. The
        // sample retains a read-only buffer for the entire access.
        let buffer = unsafe { buffer.as_ref() };
        Ok((
            buffer.pts,
            buffer.duration,
            buffer.mini_object.flags & ffi::BUFFER_DELTA_UNIT == 0,
        ))
    }

    pub fn dimensions(&self) -> Result<(u32, u32)> {
        // SAFETY: Caps are borrowed from a live sample.
        let caps = unsafe { (self.api.sample_get_caps)(self.ptr.as_ptr()) };
        if caps.is_null() {
            return Err(Error::Pipeline("sample has no caps".into()));
        }
        // SAFETY: Negotiated sample caps contain a structure at index zero.
        let structure = unsafe { (self.api.caps_get_structure)(caps, 0) };
        if structure.is_null() {
            return Err(Error::Pipeline("sample caps are empty".into()));
        }
        let mut width = 0;
        let mut height = 0;
        // SAFETY: Valid borrowed structure, static names, initialized out values.
        let valid = unsafe {
            (self.api.structure_get_int)(structure, c"width".as_ptr(), &raw mut width) != 0
                && (self.api.structure_get_int)(structure, c"height".as_ptr(), &raw mut height) != 0
        };
        if !valid || width <= 0 || height <= 0 {
            return Err(Error::Pipeline("invalid negotiated dimensions".into()));
        }
        Ok((width as u32, height as u32))
    }

    pub fn layout(&self, width: u32, height: u32) -> Result<(usize, i32)> {
        let buffer = self.buffer()?;
        // SAFETY: Meta is borrowed from the buffer retained by this sample.
        let meta = unsafe { (self.api.buffer_get_video_meta)(buffer.as_ptr()) };
        if meta.is_null() {
            let stride = width
                .checked_mul(4)
                .and_then(|n| i32::try_from(n).ok())
                .ok_or_else(|| Error::Pipeline("video row is too large".into()))?;
            return Ok((0, stride));
        }
        // SAFETY: Non-null pointer is a GstVideoMeta; access only its public prefix.
        let meta = unsafe { &*meta };
        if meta.width != width || meta.height != height || meta.n_planes != 1 {
            return Err(Error::Pipeline("unexpected BGRA video layout".into()));
        }
        Ok((meta.offset[0], meta.stride[0]))
    }
}

impl Drop for Sample {
    fn drop(&mut self) {
        // SAFETY: This wrapper owns the reference returned by appsink.
        unsafe { (self.api.mini_unref)(self.ptr.as_ptr().cast()) };
    }
}

pub(crate) fn set_property(object: &Object, name: &CStr, value: &str) -> Result<()> {
    let value =
        CString::new(value).map_err(|_| Error::Pipeline("invalid property value".into()))?;
    // SAFETY: Object and strings stay valid during this call. Callers use only
    // known properties from the selected factory's documented interface.
    unsafe { (object.api.util_set_object_arg)(object.ptr.as_ptr(), name.as_ptr(), value.as_ptr()) };
    Ok(())
}
