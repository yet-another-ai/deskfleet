use super::buffers::check;
use crate::{Error, av1_config::Config};
use deskfleet_native::rtc::VideoCodec;
use objc2_core_foundation::{CFData, CFDictionary, CFRetained, CFString};
use objc2_core_media::{self as cm, CMFormatDescription};
use std::ptr::{self, NonNull};

pub(super) fn codec_type(codec: VideoCodec) -> u32 {
    match codec {
        VideoCodec::H264 => cm::kCMVideoCodecType_H264,
        VideoCodec::H265 => cm::kCMVideoCodecType_HEVC,
        VideoCodec::Av1 => cm::kCMVideoCodecType_AV1,
    }
}

pub(super) fn hevc(
    vps: &[u8],
    sps: &[u8],
    pps: &[u8],
) -> Result<CFRetained<CMFormatDescription>, Error> {
    if [vps, sps, pps].iter().any(|bytes| bytes.is_empty()) {
        return Err("HEVC format requires VPS/SPS/PPS".into());
    }
    let mut pointers = [
        NonNull::from(&vps[0]),
        NonNull::from(&sps[0]),
        NonNull::from(&pps[0]),
    ];
    let mut lengths = [vps.len(), sps.len(), pps.len()];
    let mut raw = ptr::null();
    // SAFETY: Nonempty parameter sets remain live through this copying call.
    check(
        unsafe {
            cm::CMVideoFormatDescriptionCreateFromHEVCParameterSets(
                None,
                3,
                NonNull::from(&mut pointers[0]),
                NonNull::from(&mut lengths[0]),
                4,
                None,
                NonNull::from(&mut raw),
            )
        },
        "create HEVC format",
    )?;
    let raw = NonNull::new(raw.cast_mut()).ok_or("missing HEVC format")?;
    // SAFETY: Successful Create returned an owned reference.
    Ok(unsafe { CFRetained::from_raw(raw) })
}

pub(super) fn av1(config: &Config) -> Result<CFRetained<CMFormatDescription>, Error> {
    let key = CFString::from_str("av1C");
    let data = CFData::from_bytes(&config.av1c);
    let atoms = CFDictionary::<CFString, CFData>::from_slices(&[key.as_ref()], &[data.as_ref()]);
    // SAFETY: Immutable framework constant with process lifetime.
    let atom_key = unsafe { cm::kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms };
    let extensions = CFDictionary::<CFString, CFDictionary<CFString, CFData>>::from_slices(
        &[atom_key],
        &[atoms.as_ref()],
    );
    let mut raw = ptr::null();
    // SAFETY: Dictionary contains a checked av1C record and dimensions parsed
    // from that same sequence header. The call retains/copies its arguments.
    check(
        unsafe {
            cm::CMVideoFormatDescriptionCreate(
                None,
                cm::kCMVideoCodecType_AV1,
                i32::try_from(config.width)?,
                i32::try_from(config.height)?,
                Some(extensions.as_ref()),
                NonNull::from(&mut raw),
            )
        },
        "create AV1 format",
    )?;
    let raw = NonNull::new(raw.cast_mut()).ok_or("missing AV1 format")?;
    // SAFETY: Successful Create returned an owned reference.
    Ok(unsafe { CFRetained::from_raw(raw) })
}
