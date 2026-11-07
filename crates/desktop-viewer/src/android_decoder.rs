//! Worker-owned Android MediaCodec H.264/HEVC/AV1 decoder.

use std::cell::RefCell;
use std::time::{Duration, Instant};

use deskfleet_native::rtc::VideoCodec;
use ndk::media::media_codec::{
    DequeuedInputBufferResult, DequeuedOutputBufferInfoResult, MediaCodec, MediaCodecDirection,
    MediaFormat,
};

use crate::rtp_video::{AccessUnit, Assembler};
use crate::{Error, Frame};

const COLOR_FORMAT_YUV420_PLANAR: i32 = 19;
const COLOR_FORMAT_YUV420_SEMIPLANAR: i32 = 21;

fn mime(codec: VideoCodec) -> &'static str {
    match codec {
        VideoCodec::H264 => "video/avc",
        VideoCodec::H265 => "video/hevc",
        VideoCodec::Av1 => "video/av01",
    }
}

pub(crate) fn supported_codecs() -> Result<Vec<VideoCodec>, Error> {
    Ok([VideoCodec::Av1, VideoCodec::H265, VideoCodec::H264]
        .into_iter()
        .filter(|c| MediaCodec::from_decoder_type(mime(*c)).is_some())
        .collect())
}

pub(crate) struct RtpVideoDecoder(RefCell<Decoder>);

struct Decoder {
    codec: MediaCodec,
    assembler: Assembler,
    pending: Option<AccessUnit>,
    format: OutputLayout,
    ticks: u64,
    last_timestamp: Option<u32>,
}

#[derive(Clone, Copy)]
struct OutputLayout {
    width: u32,
    height: u32,
    stride: usize,
    slice_height: usize,
    crop_left: usize,
    crop_top: usize,
    color_format: i32,
    bt709: bool,
    full_range: bool,
}

impl RtpVideoDecoder {
    pub(crate) fn with_codec(
        payload_type: u8,
        video: VideoCodec,
        width: u32,
        height: u32,
    ) -> Result<Self, Error> {
        let codec = MediaCodec::from_decoder_type(mime(video))
            .ok_or_else(|| format!("no Android MediaCodec decoder for {video:?}"))?;
        let mut format = MediaFormat::new();
        format.set_str("mime", mime(video));
        format.set_i32("width", i32::try_from((width.max(2) + 1) & !1)?);
        format.set_i32("height", i32::try_from((height.max(2) + 1) & !1)?);
        codec.configure(&format, None, MediaCodecDirection::Decoder)?;
        codec.start()?;
        let layout = OutputLayout::from_format(&codec.output_format(), width, height);
        tracing::info!(?video, width, height, "Android MediaCodec viewer decoder started");
        Ok(Self(RefCell::new(Decoder {
            codec,
            assembler: Assembler::for_codec(payload_type, video),
            pending: None,
            format: layout,
            ticks: 0,
            last_timestamp: None,
        })))
    }

    pub(crate) fn try_push(&self, packet: &[u8]) -> Result<bool, Error> {
        let mut inner = self.0.borrow_mut();
        if inner.pending.is_some() {
            return Ok(false);
        }
        inner.assembler.push(packet).map_err(Into::into)
    }

    pub(crate) fn next_frame(&self, timeout: Duration) -> Result<Option<Frame>, Error> {
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

    pub(crate) fn take_keyframe_request(&self) -> bool {
        self.0.borrow_mut().assembler.take_request()
    }

    pub(crate) fn stop(&self) -> Result<(), Error> {
        let inner = self.0.borrow();
        let _ = inner.codec.flush();
        inner.codec.stop()?;
        Ok(())
    }
}

fn fmt_usize(format: &MediaFormat, key: &str) -> Option<usize> {
    format.i32(key).and_then(|v| usize::try_from(v).ok())
}

impl OutputLayout {
    fn from_format(format: &MediaFormat, fallback_width: u32, fallback_height: u32) -> Self {
        let raw_w = fmt_usize(format, "width").filter(|&v| v > 0).unwrap_or(fallback_width as usize);
        let raw_h = fmt_usize(format, "height").filter(|&v| v > 0).unwrap_or(fallback_height as usize);
        let crop_left = fmt_usize(format, "crop-left").unwrap_or(0);
        let crop_top = fmt_usize(format, "crop-top").unwrap_or(0);
        let width = fmt_usize(format, "crop-right")
            .and_then(|r| r.checked_add(1)?.checked_sub(crop_left))
            .filter(|&w| w > 0)
            .unwrap_or(raw_w) as u32;
        let height = fmt_usize(format, "crop-bottom")
            .and_then(|b| b.checked_add(1)?.checked_sub(crop_top))
            .filter(|&h| h > 0)
            .unwrap_or(raw_h) as u32;
        Self {
            width,
            height,
            stride: fmt_usize(format, "stride").unwrap_or(raw_w).max(raw_w),
            slice_height: fmt_usize(format, "slice-height").unwrap_or(raw_h).max(raw_h),
            crop_left,
            crop_top,
            color_format: format.i32("color-format").unwrap_or(COLOR_FORMAT_YUV420_SEMIPLANAR),
            bt709: format.i32("color-standard") == Some(1),
            full_range: format.i32("color-range") == Some(1),
        }
    }
}

impl Decoder {
    fn poll(&mut self) -> Result<Option<Frame>, Error> {
        if let Some(frame) = self.drain_output()? {
            return Ok(Some(frame));
        }
        if self.pending.is_none() {
            self.pending = self.assembler.poll(Instant::now());
        }
        if let Some(unit) = &self.pending {
            let ticks = self
                .last_timestamp
                .map_or(0, |prev| self.ticks + u64::from(unit.timestamp.wrapping_sub(prev)));
            let pts_us = u64::try_from(u128::from(ticks) * 1_000_000 / 90_000)?;
            if let DequeuedInputBufferResult::Buffer(mut input) =
                self.codec.dequeue_input_buffer(Duration::ZERO)?
            {
                let dst = input.buffer_mut();
                if unit.bytes.len() > dst.len() {
                    return Err("compressed access unit exceeds MediaCodec input buffer".into());
                }
                for (slot, &byte) in dst.iter_mut().zip(&unit.bytes) {
                    slot.write(byte);
                }
                let len = unit.bytes.len();
                let timestamp = unit.timestamp;
                self.codec.queue_input_buffer(input, 0, len, pts_us, 0)?;
                self.pending = None;
                self.last_timestamp = Some(timestamp);
                self.ticks = ticks;
            }
        }
        self.drain_output()
    }

    fn drain_output(&mut self) -> Result<Option<Frame>, Error> {
        for _ in 0..4 {
            match self.codec.dequeue_output_buffer(Duration::ZERO)? {
                DequeuedOutputBufferInfoResult::TryAgainLater => return Ok(None),
                DequeuedOutputBufferInfoResult::OutputBuffersChanged => continue,
                DequeuedOutputBufferInfoResult::OutputFormatChanged => {
                    self.format = OutputLayout::from_format(
                        &self.codec.output_format(),
                        self.format.width,
                        self.format.height,
                    );
                }
                DequeuedOutputBufferInfoResult::Buffer(output) => {
                    let info = *output.info();
                    let offset = usize::try_from(info.offset().max(0))?;
                    let size = usize::try_from(info.size().max(0))?;
                    let slice = output
                        .buffer()
                        .get(offset..offset.saturating_add(size))
                        .ok_or("MediaCodec output buffer slice out of bounds")?;
                    let frame = (size > 0).then(|| decode_yuv_to_rgba(slice, self.format)).transpose()?;
                    self.codec.release_output_buffer(output, false)?;
                    if frame.is_some() {
                        return Ok(frame);
                    }
                }
            }
        }
        Ok(None)
    }
}

fn decode_yuv_to_rgba(data: &[u8], layout: OutputLayout) -> Result<Frame, Error> {
    let (width, height) = (layout.width as usize, layout.height as usize);
    if width == 0 || height == 0 {
        return Err("invalid decoded frame dimensions".into());
    }
    let stride = layout.stride.max(layout.crop_left + width);
    let slice_height = layout.slice_height.max(layout.crop_top + height);
    let y_plane_size = stride * slice_height;
    let chroma_rows = (layout.crop_top + height).div_ceil(2);
    let planar = layout.color_format == COLOR_FORMAT_YUV420_PLANAR;
    let uv_stride = stride / 2;
    let u_plane_size = uv_stride * (slice_height / 2);
    let needed = if planar {
        y_plane_size + u_plane_size + uv_stride * chroma_rows
    } else {
        y_plane_size + stride * chroma_rows
    };
    if data.len() < needed {
        return Err("truncated YUV buffer from MediaCodec".into());
    }
    let (scale, red, green_u, green_v, blue) = match (layout.bt709, layout.full_range) {
        (true, false) => (298, 459, 55, 136, 541),
        (false, false) => (298, 409, 100, 208, 516),
        (true, true) => (256, 403, 48, 120, 475),
        (false, true) => (256, 359, 88, 183, 454),
    };
    let luma_offset = if layout.full_range { 0 } else { 16 };
    let mut pixels = vec![0_u8; width * height * 4];
    let chroma_data = &data[y_plane_size..];

    for y in 0..height {
        let src_y = layout.crop_top + y;
        let luma_row = &data[src_y * stride..];
        let cy = src_y / 2;
        for x in 0..width {
            let src_x = layout.crop_left + x;
            let luma = i32::from(luma_row[src_x]) - luma_offset;
            let (u, v) = if planar {
                let cx = cy * uv_stride + src_x / 2;
                (i32::from(chroma_data[cx]) - 128, i32::from(chroma_data[u_plane_size + cx]) - 128)
            } else {
                let cx = cy * stride + (src_x & !1);
                (i32::from(chroma_data[cx]) - 128, i32::from(chroma_data[cx + 1]) - 128)
            };
            let dst = &mut pixels[(y * width + x) * 4..][..4];
            dst[0] = ((scale * luma + red * v + 128) >> 8).clamp(0, 255) as u8;
            dst[1] = ((scale * luma - green_u * u - green_v * v + 128) >> 8).clamp(0, 255) as u8;
            dst[2] = ((scale * luma + blue * u + 128) >> 8).clamp(0, 255) as u8;
            dst[3] = 255;
        }
    }

    Ok(Frame {
        width: layout.width,
        height: layout.height,
        pixels,
        ready_at: Instant::now(),
    })
}
