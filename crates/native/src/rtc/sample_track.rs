use std::sync::Arc;
use std::time::Instant;

use rtc::media::Sample;
use rtc::media_stream::MediaStreamTrack;
use rtc::rtp::packetizer::{Packetizer, Payloader, new_packetizer};
use rtc::rtp::sequence::new_random_sequencer;
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind,
};
use tokio::sync::Mutex;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::track_local::static_rtp::TrackLocalStaticRTP;
use webrtc::peer_connection::PeerConnection;
use webrtc::rtp_transceiver::RtpSender;

use super::{PeerError, Result, codecs, h265_payloader::H265Payloader};

/// Owns packetization so H.265 accepts mixed Annex B start-code lengths and
/// every sample uses the negotiated payload type and compatible codec profile.
pub(super) struct SampleTrack {
    pub(super) track: Arc<TrackLocalStaticRTP>,
    sender: Arc<dyn RtpSender>,
    codec: RTCRtpCodec,
    packetizer: Mutex<Box<dyn Packetizer>>,
}

impl SampleTrack {
    pub(super) async fn new(
        pc: &dyn PeerConnection,
        codec: RTCRtpCodec,
        id: &str,
        kind: RtpCodecKind,
    ) -> Result<Self> {
        let ssrc = rand::random::<u32>();
        let payloader: Box<dyn Payloader> = if codec.mime_type.eq_ignore_ascii_case("video/H265") {
            Box::new(H265Payloader)
        } else {
            codec.payloader()?
        };
        let packetizer = new_packetizer(
            Instant::now(),
            1200,
            0, // Negotiated payload type is applied for each sample below.
            ssrc,
            payloader,
            Box::new(new_random_sequencer()),
            codec.clock_rate,
        );
        let track = Arc::new(TrackLocalStaticRTP::new(MediaStreamTrack::new(
            "deskfleet".to_owned(),
            format!("{id}-{ssrc:08x}"),
            id.to_owned(),
            kind,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters {
                    ssrc: Some(ssrc),
                    ..Default::default()
                },
                codec: codec.clone(),
                ..Default::default()
            }],
        )));
        let sender = pc.add_track(track.clone()).await?;
        Ok(Self {
            track,
            sender,
            codec,
            packetizer: Mutex::new(Box::new(packetizer)),
        })
    }

    pub(super) async fn write_sample(&self, sample: &Sample) -> Result<()> {
        let parameters = self.sender.get_parameters().await?;
        let codec = parameters
            .rtp_parameters
            .codecs
            .iter()
            .find(|codec| codecs::profiles_match(&self.codec, &codec.rtp_codec))
            .ok_or(PeerError::IncompatibleVideoCodec)?;
        // Hold this lock through writes so concurrent samples cannot interleave
        // their fragments or put sequence numbers on the wire out of order.
        let mut packetizer = self.packetizer.lock().await;
        let ticks =
            (sample.duration.as_nanos() * u128::from(self.codec.clock_rate) / 1_000_000_000) as u32;
        let packets = packetizer.packetize(sample.timestamp, &sample.data, ticks)?;
        for mut packet in packets {
            packet.header.payload_type = codec.payload_type;
            self.track.write_rtp(packet).await?;
        }
        Ok(())
    }
}
