use rtc::rtp_transceiver::rtp_sender::RTCPFeedback;
use rtc::rtp_transceiver::rtp_sender::{RTCRtpCodec, RTCRtpCodecParameters, RtpCodecKind};
use webrtc::peer_connection::MediaEngine;
use webrtc::peer_connection::RTCSessionDescription;

use super::{PeerConfig, PeerError, Result, VideoCodec};

pub(super) fn video_capability(codec: VideoCodec) -> RTCRtpCodec {
    let (mime_type, fmtp) = match codec {
        VideoCodec::H264 => (
            "video/H264",
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e034",
        ),
        VideoCodec::H265 => ("video/H265", "profile-id=1;tier-flag=0;level-id=120"),
        VideoCodec::Av1 => ("video/AV1", "profile=0;level-idx=8;tier=0"),
    };
    RTCRtpCodec {
        mime_type: mime_type.to_owned(),
        clock_rate: 90_000,
        channels: 0,
        sdp_fmtp_line: fmtp.to_owned(),
        rtcp_feedback: vec![
            RTCPFeedback {
                typ: "nack".to_owned(),
                parameter: String::new(),
            },
            RTCPFeedback {
                typ: "nack".to_owned(),
                parameter: "pli".to_owned(),
            },
            RTCPFeedback {
                typ: "ccm".to_owned(),
                parameter: "fir".to_owned(),
            },
        ],
    }
}

pub(super) fn audio_capability() -> RTCRtpCodec {
    RTCRtpCodec {
        mime_type: "audio/opus".to_owned(),
        clock_rate: 48_000,
        channels: 2,
        sdp_fmtp_line: "minptime=10;useinbandfec=1;stereo=1".to_owned(),
        ..Default::default()
    }
}

pub(super) fn media_engine(config: &PeerConfig) -> Result<MediaEngine> {
    let mut media = MediaEngine::default();
    if let Some(codec) = config.video {
        media.register_codec(
            RTCRtpCodecParameters {
                rtp_codec: video_capability(codec),
                payload_type: match codec {
                    VideoCodec::H264 => 102,
                    VideoCodec::H265 => 104,
                    VideoCodec::Av1 => 45,
                },
            },
            RtpCodecKind::Video,
        )?;
    }
    if config.audio {
        media.register_codec(
            RTCRtpCodecParameters {
                rtp_codec: audio_capability(),
                payload_type: 111,
            },
            RtpCodecKind::Audio,
        )?;
    }
    Ok(media)
}

// webrtc-rs deliberately falls back to a MIME-only match. Encoded streams
// cannot use that fallback when the remote codec has another profile.
pub(super) fn profiles_match(expected: &RTCRtpCodec, actual: &RTCRtpCodec) -> bool {
    if !expected.mime_type.eq_ignore_ascii_case(&actual.mime_type) {
        return false;
    }
    let fmtp = &actual.sdp_fmtp_line;
    match expected.mime_type.as_str() {
        "video/H264" => {
            let Some(profile) = parameter(fmtp, "profile-level-id") else {
                return false;
            };
            profile.len() == 6
                && profile.bytes().all(|byte| byte.is_ascii_hexdigit())
                && profile[..4].eq_ignore_ascii_case("42e0")
                && parameter(fmtp, "packetization-mode") == Some("1")
        }
        "video/H265" => parameter(fmtp, "profile-id").unwrap_or("1") == "1",
        "video/AV1" => parameter(fmtp, "profile").unwrap_or("0") == "0",
        _ => true,
    }
}

fn parameter<'a>(fmtp: &'a str, key: &str) -> Option<&'a str> {
    fmtp.split(';').find_map(|item| {
        let (name, value) = item.trim().split_once('=')?;
        name.trim()
            .eq_ignore_ascii_case(key)
            .then_some(value.trim())
    })
}

pub(super) fn validate_remote_video(
    description: &RTCSessionDescription,
    codec: Option<VideoCodec>,
) -> Result<()> {
    let Some(codec) = codec else {
        return Ok(());
    };
    let expected = video_capability(codec);
    let parsed = description.unmarshal()?;
    for media in parsed.media_descriptions {
        if media.media_name.media != "video"
            || media.media_name.port.value == 0
            || media.has_attribute("inactive")
            || media.has_attribute("sendonly")
        {
            continue;
        }
        for attribute in &media.attributes {
            if attribute.key != "rtpmap" {
                continue;
            }
            let Some((payload_type, encoding)) = attribute
                .value
                .as_deref()
                .and_then(|value| value.split_once(' '))
            else {
                continue;
            };
            if !media
                .media_name
                .formats
                .iter()
                .any(|format| format == payload_type)
            {
                continue;
            }
            let Some((name, clock)) = encoding.split_once('/') else {
                continue;
            };
            if clock != "90000" {
                continue;
            }
            let fmtp = media
                .attributes
                .iter()
                .filter(|attribute| attribute.key == "fmtp")
                .filter_map(|attribute| attribute.value.as_deref()?.split_once(' '))
                .find_map(|(id, parameters)| (id == payload_type).then_some(parameters))
                .unwrap_or("");
            let actual = RTCRtpCodec {
                mime_type: format!("video/{name}"),
                sdp_fmtp_line: fmtp.to_owned(),
                ..Default::default()
            };
            if profiles_match(&expected, &actual) {
                return Ok(());
            }
        }
    }
    Err(PeerError::IncompatibleVideoCodec)
}
