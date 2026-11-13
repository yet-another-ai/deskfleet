//! Codec-specific depayloader alignment is part of packet-loss recovery.
use crate::Codec;

pub(super) const MAX_INPUT_BYTES: u64 = 1024 * 1024;
pub(super) const MAX_INPUT_PACKETS: u64 = 256;

pub(super) fn depay(codec: Codec) -> &'static str {
    match codec {
        Codec::H264 => "rtph264depay",
        Codec::H265 => "rtph265depay",
        Codec::Av1 => "rtpav1depay",
    }
}

pub(super) fn codec_description(payload_type: u8, codec: Codec, factory: &str) -> String {
    let settings = match factory {
        // compliance is a GstH264Decoder property, not a GstH265Decoder property.
        "vah264dec" | "nvh264dec" => "compliance=flexible",
        "vaapih264dec" | "vaapih265dec" => "low-latency=true",
        "avdec_h264" | "avdec_h265" | "avdec_av1" => "max-threads=1",
        _ => "",
    };
    let encoding = match codec {
        Codec::H264 => "H264",
        Codec::H265 => "H265",
        Codec::Av1 => "AV1",
    };
    let depay = depay(codec);
    let caps = codec.output_caps();
    let parser = codec.parser();
    let recovery = "request-keyframe=true wait-for-keyframe=true";
    let assembly = match codec {
        // wait-for-keyframe must see complete pictures, including their in-band
        // parameter sets. A parser after NAL-aligned output cannot restore headers
        // already discarded by the depayloader while waiting for an IDR/IRAP.
        Codec::H264 | Codec::H265 => format!("{depay} {recovery} ! {caps} ! {parser}"),
        // rtpav1depay emits OBU alignment and gates the entire new sequence using
        // the RTP N bit, retaining its sequence header. Only av1parse can convert
        // those OBUs into complete temporal units; TU caps cannot precede it.
        Codec::Av1 => format!("{depay} {recovery} ! {parser} ! {caps}"),
    };
    format!(
        "appsrc name=input is-live=true format=time do-timestamp=true block=false \
         max-bytes={MAX_INPUT_BYTES} max-buffers={MAX_INPUT_PACKETS} \
         caps=application/x-rtp,media=video,encoding-name={encoding},clock-rate=90000,payload={payload_type} ! \
         rtpjitterbuffer latency=10 faststart-min-packets=1 do-lost=true drop-on-latency=true ! \
         {assembly} ! {factory} name=decoder {settings} ! videoconvert ! video/x-raw,format=RGBA ! \
         appsink name=frames sync=false max-buffers=1 drop=false \
         enable-last-sample=false wait-on-eos=false"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nal_codecs_negotiate_complete_depayloader_access_units_before_parsing() {
        for (codec, factory, depay, caps, parser) in [
            (
                Codec::H264,
                "vah264dec",
                "rtph264depay",
                "video/x-h264,stream-format=byte-stream,alignment=au",
                "h264parse",
            ),
            (
                Codec::H265,
                "vah265dec",
                "rtph265depay",
                "video/x-h265,stream-format=byte-stream,alignment=au",
                "h265parse",
            ),
        ] {
            let pipeline = codec_description(104, codec, factory);
            assert!(pipeline.contains(&format!(
                "{depay} request-keyframe=true wait-for-keyframe=true ! {caps} ! {parser}"
            )));
            assert!(pipeline.contains("sync=false max-buffers=1 drop=false"));
        }
    }

    #[test]
    fn av1_retains_obu_depayloader_output_until_the_parser_assembles_temporal_units() {
        let pipeline = codec_description(45, Codec::Av1, "vaav1dec");
        assert!(pipeline.contains("encoding-name=AV1,clock-rate=90000,payload=45"));
        assert!(pipeline.contains("rtpav1depay request-keyframe=true wait-for-keyframe=true ! av1parse ! video/x-av1,stream-format=obu-stream,alignment=tu"));
    }
}
