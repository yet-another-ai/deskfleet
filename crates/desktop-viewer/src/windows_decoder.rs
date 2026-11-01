//! Thread-owned Media Foundation H.264/D3D11 decoder. No playback clock or EOS
//! flushing: output is polled even while the remote desktop is idle.

#![allow(unsafe_code)]

use std::{
    cell::RefCell,
    marker::PhantomData,
    mem::ManuallyDrop,
    rc::Rc,
    time::{Duration, Instant},
};

use windows::Win32::{
    Graphics::{Direct3D::D3D_DRIVER_TYPE_HARDWARE, Direct3D11::*},
    Media::MediaFoundation::*,
    System::{Com::*, Variant::VARIANT},
};
use windows::core::{GUID, Interface};

use crate::{
    Error, Frame,
    h264::{AccessUnit, Assembler},
};

// wmcodecdsp.h: the system decoder supports synchronous ProcessInput/Output,
// D3D11 acceleration and dynamic output-type negotiation from in-band SPS/PPS.
const H264_DECODER: GUID = GUID::from_u128(0x62ce7e72_4c71_4d20_b15d_452831a87d9d);

struct Runtime(PhantomData<Rc<()>>);
impl Runtime {
    fn new() -> Result<Self, Error> {
        // SAFETY: Created and destroyed on one blocking decode worker. Successful
        // apartment initialization (including S_FALSE) is balanced exactly once.
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        }
        // SAFETY: MF is reference counted and outlives all owned interfaces.
        if let Err(error) = unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) } {
            // SAFETY: Initialization above succeeded on this thread.
            unsafe {
                CoUninitialize();
            }
            return Err(error.into());
        }
        Ok(Self(PhantomData))
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        // SAFETY: All decoder and device interfaces have already been released.
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

pub(crate) struct RtpVideoDecoder(RefCell<Decoder>);

struct Decoder {
    transform: IMFTransform,
    _manager: Option<IMFDXGIDeviceManager>,
    _device: Option<ID3D11Device>,
    assembler: Assembler,
    pending: Option<AccessUnit>,
    size: (u32, u32),
    hardware: bool,
    bt709: bool,
    full_range: bool,
    ticks: u64,
    last_timestamp: Option<u32>,
    _runtime: Runtime,
}

impl RtpVideoDecoder {
    pub fn new(payload_type: u8) -> Result<Self, Error> {
        let hardware = match std::env::var("DESKFLEET_VIEWER_DECODER").as_deref() {
            Ok("auto") | Err(std::env::VarError::NotPresent) => true,
            Ok("software") => false,
            _ => return Err("DESKFLEET_VIEWER_DECODER must be auto or software".into()),
        };
        let runtime = Runtime::new()?;
        // SAFETY: The calling thread owns COM/MF and retains every returned
        // interface. Stream zero is the system decoder's documented stream ID.
        let (transform, manager, device) = unsafe {
            let transform: IMFTransform =
                CoCreateInstance(&H264_DECODER, None, CLSCTX_INPROC_SERVER)?;
            let codec: ICodecAPI = transform.cast()?;
            // Microsoft's H.264 decoder requires VT_UI4 for this property.
            codec.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(1_u32))?;
            let (manager, device) = if hardware {
                let mut device = None;
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    windows::Win32::Foundation::HMODULE::default(),
                    D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    None,
                )?;
                let device = device.ok_or("D3D11 returned no decoder device")?;
                let _ = device
                    .GetImmediateContext()?
                    .cast::<ID3D11Multithread>()?
                    .SetMultithreadProtected(true);
                let mut token = 0;
                let mut manager = None;
                MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
                let manager = manager.ok_or("MF returned no DXGI device manager")?;
                manager.ResetDevice(&device, token)?;
                transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)?;
                (Some(manager), Some(device))
            } else {
                (None, None)
            };
            let input = MFCreateMediaType()?;
            input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            // Constrained baseline from DeskFleet has no FMO/ASO. Require DXVA
            // instead of silently accepting system-memory software output.
            if hardware {
                input.SetUINT32(&MF_MT_VIDEO_H264_NO_FMOASO, 1)?;
            }
            transform.SetInputType(0, &input, 0)?;
            (transform, manager, device)
        };
        let mut decoder = Decoder {
            transform,
            _manager: manager,
            _device: device,
            assembler: Assembler::new(payload_type),
            pending: None,
            size: (0, 0),
            hardware,
            bt709: false,
            full_range: false,
            ticks: 0,
            last_timestamp: None,
            _runtime: runtime,
        };
        decoder.output_type()?;
        // SAFETY: Types and device manager have been installed before streaming.
        unsafe {
            decoder
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            decoder
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
        }
        tracing::info!(hardware, "Media Foundation viewer decoder started");
        Ok(Self(RefCell::new(decoder)))
    }

    pub fn try_push(&self, packet: &[u8]) -> Result<bool, Error> {
        let mut inner = self.0.borrow_mut();
        if inner.pending.is_some() {
            return Ok(false);
        }
        inner.assembler.push(packet).map_err(Into::into)
    }

    pub fn next_frame(&self, timeout: Duration) -> Result<Option<Frame>, Error> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(frame) = self.0.borrow_mut().poll()? {
                return Ok(Some(frame));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(
                Duration::from_millis(1).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }

    pub fn take_keyframe_request(&self) -> bool {
        self.0.borrow_mut().assembler.take_request()
    }

    pub fn stop(&self) -> Result<(), Error> {
        // SAFETY: Only this worker drives the transform. Flush releases retained
        // reference surfaces without inventing an EOS frame on shutdown.
        unsafe {
            self.0
                .borrow()
                .transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
        }
        Ok(())
    }
}

impl Decoder {
    fn output_type(&mut self) -> Result<(), Error> {
        // SAFETY: Enumerate types on the live system decoder, selecting NV12 only.
        unsafe {
            for index in 0..32 {
                let media = self.transform.GetOutputAvailableType(0, index)?;
                if media.GetGUID(&MF_MT_SUBTYPE)? != MFVideoFormat_NV12 {
                    continue;
                }
                self.transform.SetOutputType(0, &media, 0)?;
                if let Ok(size) = media.GetUINT64(&MF_MT_FRAME_SIZE) {
                    self.size = ((size >> 32) as u32, size as u32);
                }
                self.bt709 = media.GetUINT32(&MF_MT_YUV_MATRIX).ok()
                    == Some(MFVideoTransferMatrix_BT709.0 as u32);
                self.full_range = media.GetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE).ok()
                    == Some(MFNominalRange_0_255.0 as u32);
                return Ok(());
            }
        }
        Err("Media Foundation offers no NV12 output".into())
    }

    fn poll(&mut self) -> Result<Option<Frame>, Error> {
        // Drain before submitting compressed input; ProcessInput may report
        // NOTACCEPTING, in which case the exact same complete AU is retained.
        if let Some(frame) = self.output()? {
            return Ok(Some(frame));
        }
        if self.pending.is_none() {
            self.pending = self.assembler.poll(Instant::now());
        }
        let Some(unit) = &self.pending else {
            return Ok(None);
        };
        let timestamp = unit.timestamp;
        let ticks = match self.last_timestamp {
            Some(previous) => self.ticks + u64::from(timestamp.wrapping_sub(previous)),
            None => 0,
        };
        // SAFETY: The new buffer has enough capacity; the copy is bounded by
        // the checked AU length and the sample retains its buffer after submit.
        unsafe {
            let length = u32::try_from(unit.bytes.len())?;
            let buffer = MFCreateMemoryBuffer(length)?;
            let mut ptr = std::ptr::null_mut();
            buffer.Lock(&mut ptr, None, None)?;
            std::ptr::copy_nonoverlapping(unit.bytes.as_ptr(), ptr, unit.bytes.len());
            buffer.Unlock()?;
            buffer.SetCurrentLength(length)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(i64::try_from(u128::from(ticks) * 10_000_000 / 90_000)?)?;
            match self.transform.ProcessInput(0, &sample, 0) {
                Ok(()) => {
                    self.pending = None;
                    self.last_timestamp = Some(timestamp);
                    self.ticks = ticks;
                }
                Err(error) if error.code() == MF_E_NOTACCEPTING => return Ok(None),
                Err(error) => return Err(error.into()),
            }
        }
        self.output()
    }

    fn output(&mut self) -> Result<Option<Frame>, Error> {
        for _ in 0..4 {
            // SAFETY: The decoder owns stream zero and reports its allocation contract.
            let info = unsafe { self.transform.GetOutputStreamInfo(0)? };
            let mut output = MFT_OUTPUT_DATA_BUFFER::default();
            if info.dwFlags
                & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32
                    | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32)
                == 0
            {
                // SAFETY: Allocate the exact size/alignment requested by the MFT.
                let sample = unsafe {
                    let sample = MFCreateSample()?;
                    sample.AddBuffer(&MFCreateAlignedMemoryBuffer(
                        info.cbSize,
                        info.cbAlignment.saturating_sub(1),
                    )?)?;
                    sample
                };
                output.pSample = ManuallyDrop::new(Some(sample));
            }
            let mut status = 0;
            // SAFETY: ABI fields are initialized and owned references are taken
            // once below on every return path, including stream-change/errors.
            let result = unsafe {
                self.transform
                    .ProcessOutput(0, std::slice::from_mut(&mut output), &mut status)
            };
            // SAFETY: The ABI struct has no destructor; transfer its references.
            let (sample, events) = unsafe {
                (
                    ManuallyDrop::take(&mut output.pSample),
                    ManuallyDrop::take(&mut output.pEvents),
                )
            };
            drop(events);
            match result {
                Err(error) if error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(None),
                Err(error) if error.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    self.output_type()?;
                    continue;
                }
                Err(error) => return Err(error.into()),
                Ok(()) => {}
            }
            let sample = sample.ok_or("decoder returned no sample")?;
            // SAFETY: The sample retains its output buffer through CPU readback.
            let buffer = unsafe { sample.GetBufferByIndex(0)? };
            if self.hardware && buffer.cast::<IMFDXGIBuffer>().is_err() {
                return Err("Media Foundation did not produce a hardware decoded surface".into());
            }
            let (width, height) = self.size;
            if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
                return Err("invalid decoded NV12 dimensions".into());
            }
            let length = usize::try_from(u64::from(width) * u64::from(height) * 3 / 2)?;
            let mut nv12 = vec![0; length];
            if let Ok(plane) = buffer.cast::<IMF2DBuffer>() {
                // SAFETY: ContiguousCopyTo removes native row padding; validate
                // the required allocation before allowing native code to write.
                unsafe {
                    if plane.GetContiguousLength()? as usize != length {
                        return Err("unexpected NV12 surface layout".into());
                    }
                    plane.ContiguousCopyTo(&mut nv12)?;
                }
            } else {
                // SAFETY: Software diagnostic output uses a contiguous media
                // buffer. Unlock is balanced even if its length is unexpected.
                unsafe {
                    let mut ptr = std::ptr::null_mut();
                    let mut actual = 0;
                    buffer.Lock(&mut ptr, None, Some(&mut actual))?;
                    if actual as usize == length {
                        nv12.copy_from_slice(std::slice::from_raw_parts(ptr, length));
                    }
                    buffer.Unlock()?;
                    if actual as usize != length {
                        return Err("unexpected software NV12 layout".into());
                    }
                }
            }
            let pixels = nv12_rgba(
                &nv12,
                width as usize,
                height as usize,
                self.bt709,
                self.full_range,
            );
            return Ok(Some(Frame {
                width,
                height,
                pixels,
                ready_at: Instant::now(),
            }));
        }
        Err("repeated decoder output format changes".into())
    }
}

// Honor the negotiated color metadata; unspecified SDR output uses BT.601.
fn nv12_rgba(input: &[u8], width: usize, height: usize, bt709: bool, full_range: bool) -> Vec<u8> {
    let mut pixels = vec![0; width * height * 4];
    for y in 0..height {
        for x in 0..width {
            let luma = i32::from(input[y * width + x]) - if full_range { 0 } else { 16 };
            let chroma = width * height + (y / 2) * width + (x & !1);
            let u = i32::from(input[chroma]) - 128;
            let v = i32::from(input[chroma + 1]) - 128;
            let (scale, red, green_u, green_v, blue) = match (bt709, full_range) {
                (true, false) => (298, 459, 55, 136, 541),
                (false, false) => (298, 409, 100, 208, 516),
                (true, true) => (256, 403, 48, 120, 475),
                (false, true) => (256, 359, 88, 183, 454),
            };
            let rgb = [
                scale * luma + red * v,
                scale * luma - green_u * u - green_v * v,
                scale * luma + blue * u,
            ];
            let offset = (y * width + x) * 4;
            for channel in 0..3 {
                pixels[offset + channel] = ((rgb[channel] + 128) >> 8).clamp(0, 255) as u8;
            }
            pixels[offset + 3] = 255;
        }
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires Windows Media Foundation and a hardware H.264 decoder (or explicit software diagnostic)"]
    fn runtime_delivers_one_idle_idr_without_eos() {
        let decoder = RtpVideoDecoder::new(96).unwrap();
        decoder.0.borrow_mut().pending = Some(AccessUnit {
            bytes: include_bytes!("../../native/examples/fixtures/red-64x64.h264").to_vec(),
            timestamp: u32::MAX - 3000,
        });
        let frame = decoder
            .next_frame(Duration::from_secs(2))
            .unwrap()
            .expect("idle IDR must decode without another picture or EOS");
        assert_eq!((frame.width, frame.height), (64, 64));
        for pixel in frame.pixels.as_chunks::<4>().0 {
            assert!(
                pixel[0] > 230 && pixel[1] < 20 && pixel[2] < 20,
                "red RGBA: {pixel:?}"
            );
            assert_eq!(pixel[3], 255);
        }
        assert!(decoder.next_frame(Duration::ZERO).unwrap().is_none());
        decoder.stop().unwrap();
    }

    #[test]
    fn limited_range_black_and_white() {
        assert_eq!(
            nv12_rgba(&[16, 235, 16, 235, 128, 128], 2, 2, true, false),
            [
                0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255
            ]
        );
    }
}
