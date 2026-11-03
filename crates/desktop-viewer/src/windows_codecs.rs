//! Discover synchronous system decoders, including installed codec extensions.
#![allow(unsafe_code)]

use deskfleet_native::rtc::VideoCodec;
use windows::Win32::{Media::MediaFoundation::*, System::Com::*};
use windows::core::GUID;

use crate::Error;

pub(super) fn subtype(codec: VideoCodec) -> GUID {
    match codec {
        VideoCodec::H264 => MFVideoFormat_H264,
        VideoCodec::H265 => MFVideoFormat_HEVC,
        VideoCodec::Av1 => MFVideoFormat_AV1,
    }
}

pub(super) fn nal_lengths(bytes: &[u8]) -> Result<Vec<u8>, Error> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let prefix = if bytes[i..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if bytes[i..].starts_with(&[0, 0, 1]) {
            3
        } else {
            i += 1;
            continue;
        };
        starts.push(i);
        i += prefix;
    }
    if starts.first() != Some(&0) {
        return Err("HEVC sample has no Annex B prefix".into());
    }
    starts.push(bytes.len());
    let mut lengths = Vec::new();
    for pair in starts.windows(2) {
        lengths.extend(u32::try_from(pair[1] - pair[0])?.to_ne_bytes());
    }
    Ok(lengths)
}

pub(super) fn activate(codec: VideoCodec) -> Result<IMFTransform, Error> {
    if codec == VideoCodec::H264 {
        // SAFETY: The caller initialized COM and MF on this worker.
        return Ok(unsafe { CoCreateInstance(&super::H264_DECODER, None, CLSCTX_INPROC_SERVER)? });
    }
    let input = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: subtype(codec),
    };
    let mut raw = std::ptr::null_mut();
    let mut count = 0;
    // SAFETY: MF allocates an array of owned activation references. Take all
    // references before freeing the array, including when activation fails.
    let candidates: Vec<IMFActivate> = unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_DECODER,
            MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_LOCALMFT | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input),
            None,
            &mut raw,
            &mut count,
        )?;
        if raw.is_null() {
            return Err(format!("no installed {codec:?} decoder extension").into());
        }
        let values = std::slice::from_raw_parts_mut(raw, count as usize)
            .iter_mut()
            .filter_map(Option::take)
            .collect();
        CoTaskMemFree(Some(raw.cast()));
        values
    };
    for candidate in candidates {
        // SAFETY: The activation is live and owned on the initialized COM thread.
        if let Ok(transform) = unsafe { candidate.ActivateObject::<IMFTransform>() } {
            // SAFETY: Detach transfers lifetime to the returned COM interface.
            unsafe {
                candidate.DetachObject()?;
            }
            return Ok(transform);
        }
    }
    Err(format!("cannot activate installed {codec:?} decoder").into())
}
