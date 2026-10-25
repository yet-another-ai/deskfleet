//! Windows hardware H.264 fallback through Media Foundation.
//!
//! Only hardware MFTs on the capture device's adapter are considered. Captured
//! BGRA remains on that GPU and each submitted NV12 sample owns a fresh texture.

#![allow(unsafe_code)]

mod convert;
mod keyframe;
mod output;
mod setup;

use std::time::{Duration, Instant};

use deskfleet_capture::Frame;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Variant::VARIANT;
use windows::core::Interface;

use crate::{Codec, EncodedPacket, EncoderConfig, EncoderError};
use convert::GpuConverter;
use output::Output;
use setup::{Runtime, Session, set_codec_value};

const MAX_IN_FLIGHT: usize = 4;
const MAX_EVENTS_PER_POLL: usize = 64;

pub(crate) fn is_supported(device: &ID3D11Device) -> bool {
    match setup::probe(device) {
        Ok(supported) => supported,
        Err(error) => {
            tracing::debug!(%error, "hardware Media Foundation H.264 probe failed");
            false
        }
    }
}

fn platform_error(operation: &str, error: windows::core::Error) -> EncoderError {
    EncoderError::Platform(format!("{operation}: {error}"))
}

pub(crate) struct MfEncoder {
    session: Session,
    converter: GpuConverter,
    output: Output,
    config: EncoderConfig,
    pending: Option<IMFSample>,
    input_requests: usize,
    in_flight: usize,
    keyframe_requested: bool,
    draining: bool,
    drain_complete: bool,
    last_progress: Instant,
    // COM/MF outlive every interface above and are released on the same worker.
    _runtime: Runtime,
}

impl MfEncoder {
    pub(crate) fn new(config: &EncoderConfig, frame: &Frame) -> Result<Self, EncoderError> {
        if config.codec != Codec::H264 {
            return Err(EncoderError::Unsupported(
                "Media Foundation fallback only supports H.264",
            ));
        }
        config.validate()?;
        let runtime = Runtime::new()?;
        let surface = frame.surface();
        let device = surface.d3d11_device();
        let converter =
            GpuConverter::new(device, surface.d3d11_context(), config.width, config.height)?;
        let luid = setup::adapter_luid(device)
            .map_err(|error| platform_error("query capture adapter", error))?;
        let candidates = setup::hardware_candidates(luid)
            .map_err(|error| platform_error("enumerate hardware H.264 MFTs", error))?;
        let mut failures = Vec::new();
        for candidate in candidates {
            let initialized =
                Session::new(candidate, config, device).and_then(|session| {
                    let mut output = Output::new(config);
                    output.update_type(&session.output_type().map_err(|error| {
                        platform_error("query initial MFT output type", error)
                    })?)?;
                    Ok((session, output))
                });
            match initialized {
                Ok((session, output)) => {
                    return Ok(Self {
                        session,
                        converter,
                        output,
                        config: config.clone(),
                        pending: None,
                        input_requests: 0,
                        in_flight: 0,
                        keyframe_requested: true,
                        draining: false,
                        drain_complete: false,
                        last_progress: Instant::now(),
                        _runtime: runtime,
                    });
                }
                Err(error) => failures.push(error.to_string()),
            }
        }
        if failures.is_empty() {
            Err(EncoderError::Unsupported(
                "no hardware H.264 MFT for the capture adapter",
            ))
        } else {
            Err(EncoderError::Platform(format!(
                "hardware H.264 MFT initialization failed: {}",
                failures.join("; ")
            )))
        }
    }

    pub(crate) fn encode(&mut self, frame: &Frame) -> Result<Vec<EncodedPacket>, EncoderError> {
        if self.draining {
            return Err(EncoderError::InvalidConfig(
                "MFT encoder is draining".into(),
            ));
        }
        let mut packets = self.poll_output()?;
        let texture = self.converter.convert(frame)?;
        let timestamp = i64::try_from(frame.timestamp_ns / 100).map_err(|_| {
            EncoderError::InvalidConfig("capture timestamp exceeds MF range".into())
        })?;
        let duration = (10_000_000.0 / self.config.fps).round() as i64;
        // SAFETY: The new sample owns its DXGI buffer, which retains this
        // unique texture. MF may retain the sample after ProcessInput; it is
        // never returned to the capture pool or reused by the converter.
        let sample = unsafe {
            let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &texture, 0, false)
                .map_err(|error| platform_error("wrap NV12 texture", error))?;
            let length = buffer
                .cast::<IMF2DBuffer>()
                .and_then(|buffer| buffer.GetContiguousLength())
                .map_err(|error| platform_error("query NV12 buffer length", error))?;
            buffer
                .SetCurrentLength(length)
                .map_err(|error| platform_error("set NV12 buffer length", error))?;
            let sample = MFCreateSample()
                .map_err(|error| platform_error("create MFT input sample", error))?;
            sample
                .AddBuffer(&buffer)
                .map_err(|error| platform_error("attach NV12 texture", error))?;
            sample
                .SetSampleTime(timestamp)
                .map_err(|error| platform_error("set MFT input timestamp", error))?;
            sample
                .SetSampleDuration(duration)
                .map_err(|error| platform_error("set MFT input duration", error))?;
            sample
        };
        // Keep one latest sample even when all input slots are occupied. A
        // static desktop may never call encode again after requesting a keyframe;
        // poll_output must be able to submit it once capacity returns. Only
        // submit_pending admits samples to the four-slot in-flight budget.
        self.pending = Some(sample);
        self.submit_pending()?;
        packets.extend(self.poll_output()?);
        Ok(packets)
    }

    pub(crate) fn poll_output(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        let mut packets = Vec::new();
        for _ in 0..MAX_EVENTS_PER_POLL {
            // SAFETY: This MFT is exclusively driven by its owning COM worker.
            // NO_WAIT makes each poll bounded rather than blocking shutdown.
            let event = match unsafe { self.session.events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(event) => event,
                Err(error) if error.code() == MF_E_NO_EVENTS_AVAILABLE => break,
                Err(error) => return Err(platform_error("poll MFT event", error)),
            };
            // SAFETY: The event is retained for these immutable attribute reads.
            let event_type = unsafe {
                event
                    .GetStatus()
                    .and_then(|status| status.ok())
                    .map_err(|error| platform_error("hardware MFT event failed", error))?;
                event
                    .GetType()
                    .map_err(|error| platform_error("read MFT event type", error))?
            };
            if event_type == METransformNeedInput.0 as u32 {
                self.input_requests = (self.input_requests + 1).min(MAX_IN_FLIGHT);
            } else if event_type == METransformHaveOutput.0 as u32 {
                if let Some(packet) = self.output.read(&self.session, &self.config)? {
                    self.in_flight = self.in_flight.saturating_sub(1);
                    self.last_progress = Instant::now();
                    packets.push(packet);
                }
            } else if event_type == METransformDrainComplete.0 as u32 {
                self.drain_complete = true;
                self.in_flight = 0;
            }
        }
        if !self.draining {
            self.submit_pending()?;
        }
        if self.in_flight != 0 && self.last_progress.elapsed() >= Duration::from_secs(5) {
            return Err(EncoderError::Platform(
                "hardware H.264 MFT output timed out".into(),
            ));
        }
        Ok(packets)
    }

    fn submit_pending(&mut self) -> Result<(), EncoderError> {
        if self.input_requests == 0 || self.in_flight >= MAX_IN_FLIGHT {
            return Ok(());
        }
        let Some(sample) = self.pending.as_ref() else {
            return Ok(());
        };
        let result = keyframe::submit_frame(
            self.keyframe_requested,
            |value| {
                set_codec_value(
                    &self.session.codec,
                    &CODECAPI_AVEncVideoForceKeyFrame,
                    value,
                )
            },
            || {
                // SAFETY: An outstanding NeedInput event authorizes this submission.
                // The sample owns its NV12 buffer for however long the MFT retains it.
                unsafe {
                    self.session
                        .active
                        .transform
                        .ProcessInput(self.session.input_id, sample, 0)
                }
            },
        );
        match result {
            Ok(()) => {
                self.pending = None;
                self.input_requests -= 1;
                if self.in_flight == 0 {
                    self.last_progress = Instant::now();
                }
                self.in_flight += 1;
                self.keyframe_requested = false;
            }
            Err(error) if error.code() == MF_E_NOTACCEPTING => {
                // Preserve one latest frame while waiting for fresh input credit.
                self.input_requests = 0;
            }
            Err(error) => return Err(platform_error("submit MFT frame", error)),
        }
        Ok(())
    }

    pub(crate) fn request_keyframe(&mut self) {
        self.keyframe_requested = true;
    }

    pub(crate) fn set_bitrate(&self, average: u32, _maximum: u32) -> Result<(), EncoderError> {
        set_codec_value(
            &self.session.codec,
            &CODECAPI_AVEncCommonMeanBitRate,
            VARIANT::from(average),
        )
        .map_err(|error| platform_error("set MFT bitrate", error))
    }

    pub(crate) fn flush(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        if self.drain_complete {
            return Ok(Vec::new());
        }
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut packets = Vec::new();
        // An accepted encode call may still be waiting for its first NeedInput
        // event. Submit that sample before requesting drain, including on a
        // static desktop where there will not be another encode call.
        while self.pending.is_some() {
            packets.extend(self.poll_output()?);
            if self.pending.is_none() {
                break;
            }
            if Instant::now() >= deadline {
                return Err(EncoderError::Platform(
                    "hardware H.264 MFT input timed out before drain".into(),
                ));
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        self.draining = true;
        // SAFETY: No further input is submitted once draining begins.
        unsafe {
            self.session
                .active
                .transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)
        }
        .map_err(|error| platform_error("drain MFT encoder", error))?;
        while !self.drain_complete {
            packets.extend(self.poll_output()?);
            if Instant::now() >= deadline {
                return Err(EncoderError::Platform(
                    "hardware H.264 MFT drain timed out".into(),
                ));
            }
            if !self.drain_complete {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        Ok(packets)
    }
}

impl Drop for MfEncoder {
    fn drop(&mut self) {
        // SAFETY: The worker has stopped submitting/reading this transform. Flush
        // drops queued samples; Session then shuts the MFT down before Runtime.
        unsafe {
            let _ = self
                .session
                .active
                .transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = self
                .session
                .active
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::H264Profile;

    #[test]
    #[ignore = "requires an interactive Windows desktop and a hardware Media Foundation H.264 encoder"]
    fn saturated_input_preserves_latest_static_keyframe() {
        let display = deskfleet_capture::displays()
            .unwrap()
            .into_iter()
            .next()
            .expect("a display");
        let capture = deskfleet_capture::create_capture_stream(
            &display,
            &deskfleet_capture::CaptureConfig {
                fps: 30.0,
                ..Default::default()
            },
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut frame = loop {
            if let Some(frame) = capture.poll_frame().unwrap() {
                break frame;
            }
            assert!(Instant::now() < deadline, "capture produced no frame");
        };
        let config = EncoderConfig {
            width: frame.width,
            height: frame.height,
            fps: 30.0,
            h264_profile: H264Profile::ConstrainedBaseline,
            ..Default::default()
        };
        let mut encoder = MfEncoder::new(&config, &frame).unwrap();
        frame.timestamp_ns = 100_000_000;
        let mut packets = encoder.encode(&frame).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while packets.is_empty() {
            assert!(Instant::now() < deadline, "initial output timed out");
            std::thread::sleep(Duration::from_millis(5));
            packets.extend(encoder.poll_output().unwrap());
        }
        assert_eq!(encoder.in_flight, 0);

        // Hold the admission limit full deterministically rather than racing
        // the GPU. Real capture, conversion, retained samples and MFT output
        // still exercise the normal encode/poll path.
        encoder.in_flight = MAX_IN_FLIGHT;
        encoder.request_keyframe();
        for timestamp in [133_333_300, 166_666_600] {
            frame.timestamp_ns = timestamp;
            assert!(encoder.encode(&frame).unwrap().is_empty());
            assert!(encoder.pending.is_some());
            assert!(encoder.keyframe_requested);
            assert_eq!(encoder.in_flight, MAX_IN_FLIGHT);
        }
        encoder.in_flight = 0;
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut packets = Vec::new();
        while packets.is_empty() {
            assert!(
                Instant::now() < deadline,
                "retained keyframe output timed out"
            );
            std::thread::sleep(Duration::from_millis(5));
            packets.extend(encoder.poll_output().unwrap());
        }
        assert_eq!(
            packets.len(),
            1,
            "only the newest waiting frame is submitted"
        );
        assert_eq!(packets[0].timestamp_ns, frame.timestamp_ns);
        assert!(packets[0].is_keyframe);
        assert!(encoder.pending.is_none());
        assert_eq!(encoder.in_flight, 0);
        encoder.flush().unwrap();
        drop(encoder);
        capture.stop().unwrap();
    }
}
