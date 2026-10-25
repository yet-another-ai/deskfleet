//! Turn MFT samples into the Annex B packets expected by WebRTC.

use std::mem::ManuallyDrop;

use windows::Win32::Media::MediaFoundation::*;

use super::{platform_error, setup::Session};
use crate::{EncodedPacket, EncoderConfig, EncoderError, H264Profile};

pub(super) struct Output {
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
    nal_length: usize,
    profile: H264Profile,
    duration_ns: u64,
}

impl Output {
    pub(super) fn new(config: &EncoderConfig) -> Self {
        Self {
            sps: None,
            pps: None,
            nal_length: 4,
            profile: config.h264_profile,
            duration_ns: (1_000_000_000.0 / config.fps) as u64,
        }
    }

    pub(super) fn update_type(&mut self, media: &IMFMediaType) -> Result<(), EncoderError> {
        // SAFETY: The media type owns its sequence-header blob; the queried length
        // sizes the live destination and the blob is copied before returning.
        let header = unsafe {
            let Ok(size) = media.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) else {
                return Ok(());
            };
            let mut header = vec![0; size as usize];
            media
                .GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut header, None)
                .map_err(|error| platform_error("read H.264 sequence header", error))?;
            header
        };
        let annex_b = if header.first() == Some(&1) {
            let (length, data) = avcc_header(&header)?;
            self.nal_length = length;
            data
        } else {
            header
        };
        self.remember(&annex_b)
    }

    fn remember(&mut self, data: &[u8]) -> Result<(), EncoderError> {
        for nalu in nalus(data) {
            match nalu[0] & 0x1f {
                7 => {
                    if nalu.len() < 4 || !matches_profile(nalu, self.profile) {
                        return Err(EncoderError::Platform(
                            "MF H.264 SPS does not match the negotiated profile".into(),
                        ));
                    }
                    self.sps = Some(nalu.to_vec());
                }
                8 => self.pps = Some(nalu.to_vec()),
                _ => {}
            }
        }
        Ok(())
    }

    fn packet(
        &mut self,
        bytes: &[u8],
        timestamp: i64,
        duration: Option<i64>,
    ) -> Result<EncodedPacket, EncoderError> {
        let mut data = Vec::with_capacity(bytes.len() + 128);
        // A four-byte NAL length of 256..511 also starts with 00 00 01.
        // Prefer a complete length-prefixed parse before treating that prefix
        // as Annex B. A failed parse may have appended earlier NAL units.
        if crate::bitstream::convert_avcc_to_annex_b(bytes, self.nal_length, &mut data).is_none() {
            data.clear();
            if start_code(bytes, 0).is_none() {
                return Err(EncoderError::Platform(
                    "invalid MF H.264 NAL lengths".into(),
                ));
            }
            data.extend_from_slice(bytes);
        }
        self.remember(&data)?;
        let types: Vec<u8> = nalus(&data).map(|nalu| nalu[0] & 0x1f).collect();
        if types.is_empty() {
            return Err(EncoderError::Platform("empty MF H.264 sample".into()));
        }
        let is_keyframe = types.contains(&5);
        if is_keyframe {
            let (Some(sps), Some(pps)) = (&self.sps, &self.pps) else {
                return Err(EncoderError::Platform(
                    "MF keyframe has no H.264 parameter sets".into(),
                ));
            };
            if !types.contains(&7) || !types.contains(&8) {
                let mut with_headers = Vec::with_capacity(data.len() + sps.len() + pps.len() + 8);
                append_nalu(&mut with_headers, sps);
                append_nalu(&mut with_headers, pps);
                with_headers.extend_from_slice(&data);
                data = with_headers;
            }
        }
        Ok(EncodedPacket {
            data,
            timestamp_ns: hns_to_ns(timestamp)?,
            duration_ns: duration
                .filter(|value| *value > 0)
                .map(hns_to_ns)
                .transpose()?
                .unwrap_or(self.duration_ns),
            is_keyframe,
        })
    }

    pub(super) fn read(
        &mut self,
        session: &Session,
        config: &EncoderConfig,
    ) -> Result<Option<EncodedPacket>, EncoderError> {
        let transform = &session.active.transform;
        // SAFETY: The output stream ID belongs to this configured MFT.
        let info = unsafe { transform.GetOutputStreamInfo(session.output_id) }
            .map_err(|error| platform_error("query MFT output allocation", error))?;
        let mut output = MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: session.output_id,
            ..Default::default()
        };
        if info.dwFlags
            & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32
                | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32)
            == 0
        {
            // SAFETY: The MFT's required buffer size/alignment are used; the
            // sample owns the buffer until ProcessOutput returns.
            let sample = unsafe {
                let sample = MFCreateSample()
                    .map_err(|error| platform_error("allocate MFT output sample", error))?;
                let buffer =
                    MFCreateAlignedMemoryBuffer(info.cbSize, info.cbAlignment.saturating_sub(1))
                        .map_err(|error| platform_error("allocate MFT output buffer", error))?;
                sample
                    .AddBuffer(&buffer)
                    .map_err(|error| platform_error("attach MFT output buffer", error))?;
                sample
            };
            output.pSample = ManuallyDrop::new(Some(sample));
        }
        let mut status = 0;
        // SAFETY: One live output slot is provided. Both owned COM references
        // in this ABI struct are taken exactly once even on an error result.
        let result =
            unsafe { transform.ProcessOutput(0, std::slice::from_mut(&mut output), &mut status) };
        // SAFETY: These fields have not previously been taken; the ABI struct
        // has no destructor, so taking them also prevents leaking COM objects.
        let (sample, events) = unsafe {
            (
                ManuallyDrop::take(&mut output.pSample),
                ManuallyDrop::take(&mut output.pEvents),
            )
        };
        drop(events);
        match result {
            Err(error) if error.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                // SAFETY: The new type is obtained from the same output stream;
                // only H.264 at the current frame dimensions is accepted.
                let media = unsafe {
                    let media = transform
                        .GetOutputAvailableType(session.output_id, 0)
                        .map_err(|error| platform_error("query changed MFT output type", error))?;
                    if media.GetGUID(&MF_MT_SUBTYPE).ok() != Some(MFVideoFormat_H264)
                        || media.GetUINT64(&MF_MT_FRAME_SIZE).ok()
                            != Some((u64::from(config.width) << 32) | u64::from(config.height))
                    {
                        return Err(EncoderError::Platform(
                            "unexpected MF output format change".into(),
                        ));
                    }
                    transform
                        .SetOutputType(session.output_id, &media, 0)
                        .map_err(|error| platform_error("accept MFT output type", error))?;
                    media
                };
                self.update_type(&media)?;
                // An asynchronous MFT authorizes exactly one ProcessOutput
                // per HaveOutput event, including format-change results.
                return Ok(None);
            }
            Err(error) => return Err(platform_error("read MFT output", error)),
            Ok(()) => {}
        }
        if output.dwStatus & MFT_OUTPUT_DATA_BUFFER_NO_SAMPLE.0 as u32
            == MFT_OUTPUT_DATA_BUFFER_NO_SAMPLE.0 as u32
        {
            return Ok(None);
        }
        let Some(sample) = sample else {
            return Ok(None);
        };
        // SAFETY: The returned sample owns its buffers and timestamp attributes.
        let (buffer, timestamp, duration) = unsafe {
            (
                sample
                    .ConvertToContiguousBuffer()
                    .map_err(|error| platform_error("read encoded buffer", error))?,
                sample
                    .GetSampleTime()
                    .map_err(|error| platform_error("read encoded timestamp", error))?,
                sample.GetSampleDuration().ok(),
            )
        };
        let bytes = copy_buffer(&buffer)?;
        self.packet(&bytes, timestamp, duration).map(Some)
    }
}

fn copy_buffer(buffer: &IMFMediaBuffer) -> Result<Vec<u8>, EncoderError> {
    let mut pointer = std::ptr::null_mut();
    let mut length = 0;
    // SAFETY: The output pointers are initialized local storage. The buffer stays
    // retained and locked until after the copy, and is unlocked on every branch.
    unsafe {
        buffer
            .Lock(&mut pointer, None, Some(&mut length))
            .map_err(|error| platform_error("lock encoded buffer", error))?;
        let data = if length == 0 {
            Ok(Vec::new())
        } else if pointer.is_null() {
            Err(EncoderError::Platform(
                "MFT returned a null encoded buffer".into(),
            ))
        } else {
            Ok(std::slice::from_raw_parts(pointer, length as usize).to_vec())
        };
        let unlocked = buffer
            .Unlock()
            .map_err(|error| platform_error("unlock encoded buffer", error));
        unlocked.and(data)
    }
}

fn hns_to_ns(value: i64) -> Result<u64, EncoderError> {
    u64::try_from(value)
        .ok()
        .and_then(|value| value.checked_mul(100))
        .ok_or_else(|| EncoderError::Platform("MFT returned an invalid sample timestamp".into()))?;
    Ok(crate::bitstream::time_to_nanoseconds(value, 10_000_000))
}

fn matches_profile(nalu: &[u8], profile: H264Profile) -> bool {
    match profile {
        H264Profile::ConstrainedBaseline => nalu[1] == 66 && nalu[2] & 0x40 != 0,
        H264Profile::Main => nalu[1] == 77,
        H264Profile::High => nalu[1] == 100,
    }
}

fn start_code(data: &[u8], offset: usize) -> Option<usize> {
    let tail = data.get(offset..)?;
    if tail.starts_with(&[0, 0, 0, 1]) {
        Some(4)
    } else if tail.starts_with(&[0, 0, 1]) {
        Some(3)
    } else {
        None
    }
}

fn nalus(mut data: &[u8]) -> impl Iterator<Item = &[u8]> {
    std::iter::from_fn(move || {
        loop {
            let begin = (0..data.len())
                .find_map(|offset| start_code(data, offset).map(|length| offset + length))?;
            let end = (begin..data.len())
                .find(|&offset| start_code(data, offset).is_some())
                .unwrap_or(data.len());
            let nalu = &data[begin..end];
            data = &data[end..];
            if !nalu.is_empty() {
                return Some(nalu);
            }
        }
    })
}

fn append_nalu(output: &mut Vec<u8>, nalu: &[u8]) {
    output.extend_from_slice(&[0, 0, 0, 1]);
    output.extend_from_slice(nalu);
}

fn avcc_header(header: &[u8]) -> Result<(usize, Vec<u8>), EncoderError> {
    let invalid = || EncoderError::Platform("invalid MF AVC configuration record".into());
    if header.len() < 7 {
        return Err(invalid());
    }
    let length = usize::from(header[4] & 3) + 1;
    if length == 3 {
        return Err(invalid());
    }
    let mut count = usize::from(header[5] & 31);
    let mut rest = &header[6..];
    let mut output = Vec::new();
    for group in 0..2 {
        for _ in 0..count {
            let size = rest.get(..2).ok_or_else(invalid)?;
            let size = usize::from(u16::from_be_bytes([size[0], size[1]]));
            let nalu = rest.get(2..2 + size).ok_or_else(invalid)?;
            if nalu.is_empty() {
                return Err(invalid());
            }
            append_nalu(&mut output, nalu);
            rest = &rest[2 + size..];
        }
        if group == 0 {
            count = usize::from(*rest.first().ok_or_else(invalid)?);
            rest = &rest[1..];
        }
    }
    Ok((length, output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepends_cached_headers_and_preserves_mf_timing() {
        let config = EncoderConfig {
            h264_profile: H264Profile::ConstrainedBaseline,
            ..Default::default()
        };
        let mut output = Output::new(&config);
        output
            .remember(&[0, 0, 0, 1, 0x67, 66, 0xc0, 31, 0, 0, 1, 0x68, 1])
            .unwrap();
        let packet = output
            .packet(&[0, 0, 0, 2, 0x65, 0x88], 123, Some(100))
            .unwrap();
        assert_eq!(
            nalus(&packet.data).map(|n| n[0] & 31).collect::<Vec<_>>(),
            [7, 8, 5]
        );
        assert!(packet.is_keyframe);
        assert_eq!((packet.timestamp_ns, packet.duration_ns), (12_300, 10_000));
    }

    #[test]
    fn rejects_wrong_profile_and_truncated_headers() {
        let config = EncoderConfig {
            h264_profile: H264Profile::ConstrainedBaseline,
            ..Default::default()
        };
        assert!(
            Output::new(&config)
                .remember(&[0, 0, 1, 0x67, 100, 0, 31])
                .is_err()
        );
        assert!(avcc_header(&[1, 66, 0xe0, 31, 255, 225, 0, 5, 0x67]).is_err());
        assert!(hns_to_ns(-1).is_err());
    }

    #[test]
    fn length_prefixed_nalus_cannot_masquerade_as_start_codes() {
        let config = EncoderConfig {
            h264_profile: H264Profile::ConstrainedBaseline,
            ..Default::default()
        };
        for length in [256u32, 257] {
            let mut output = Output::new(&config);
            output
                .remember(&[0, 0, 1, 0x67, 66, 0xc0, 31, 0, 0, 1, 0x68, 1])
                .unwrap();
            let mut nalu = vec![0x88; length as usize];
            nalu[0] = 0x65;
            let mut sample = length.to_be_bytes().to_vec();
            sample.extend_from_slice(&nalu);
            let packet = output.packet(&sample, 0, None).unwrap();
            assert!(packet.is_keyframe);
            let nalus: Vec<_> = nalus(&packet.data).collect();
            assert_eq!(nalus.len(), 3);
            assert_eq!(nalus[2], nalu);
        }
    }

    #[test]
    fn preserves_annex_b_with_mixed_start_code_lengths() {
        let config = EncoderConfig {
            h264_profile: H264Profile::ConstrainedBaseline,
            ..Default::default()
        };
        for first_start_code in [&[0, 0, 1][..], &[0, 0, 0, 1][..]] {
            let mut sample = first_start_code.to_vec();
            sample
                .extend_from_slice(&[0x67, 66, 0xc0, 31, 0, 0, 1, 0x68, 1, 0, 0, 0, 1, 0x65, 0x88]);
            let packet = Output::new(&config).packet(&sample, 0, None).unwrap();
            assert_eq!(packet.data, sample);
            assert!(packet.is_keyframe);
        }
    }
}
