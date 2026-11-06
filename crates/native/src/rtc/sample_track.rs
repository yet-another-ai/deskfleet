use std::sync::Arc;
use std::time::{Duration, Instant};

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

use super::{PeerError, Result, codecs, h265_payloader::H265Payloader, pacing::PacingHandle};

/// Owns packetization so H.265 accepts mixed Annex B start-code lengths and
/// every sample uses the negotiated payload type and compatible codec profile.
pub(super) struct SampleTrack {
    pub(super) track: Arc<TrackLocalStaticRTP>,
    sender: Arc<dyn RtpSender>,
    codec: RTCRtpCodec,
    packetizer: Mutex<SamplePacketizer>,
    pacing: Option<PacingHandle>,
}

impl SampleTrack {
    pub(super) async fn new(
        pc: &dyn PeerConnection,
        codec: RTCRtpCodec,
        id: &str,
        kind: RtpCodecKind,
        pacing: Option<PacingHandle>,
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
            packetizer: Mutex::new(SamplePacketizer {
                inner: Box::new(packetizer),
                clock: SampleClock::default(),
            }),
            pacing,
        })
    }

    pub(super) async fn write_sample(
        &self,
        sample: &Sample,
        timestamp_ns: Option<u64>,
    ) -> Result<()> {
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
        let advance =
            packetizer
                .clock
                .advance(timestamp_ns, sample.duration, self.codec.clock_rate);
        packetizer.inner.skip_samples(advance);
        // Advance before emitting this frame, so a capture pause is reflected in
        // the first resumed RTP timestamp rather than one frame later.
        let packets = packetizer
            .inner
            .packetize(sample.timestamp, &sample.data, 0)?;
        let receipt = self
            .pacing
            .as_ref()
            .zip(packets.last())
            .map(|(pacing, last)| {
                pacing.prepare_sample(last.header.ssrc, last.header.sequence_number)
            });
        for mut packet in packets {
            packet.header.payload_type = codec.payload_type;
            self.track.write_rtp(packet).await?;
        }
        if let Some(receipt) = receipt {
            receipt.await.map_err(|_| PeerError::Closed)?;
        }
        Ok(())
    }
}

struct SamplePacketizer {
    inner: Box<dyn Packetizer>,
    clock: SampleClock,
}

#[derive(Default)]
struct SampleClock {
    previous_capture: Option<u64>,
    previous_duration: u32,
}

impl SampleClock {
    fn advance(&mut self, timestamp_ns: Option<u64>, duration: Duration, clock_rate: u32) -> u32 {
        let advance = match (self.previous_capture, timestamp_ns) {
            (Some(previous), Some(current)) if current > previous => {
                // Convert absolute capture times before subtracting to retain
                // fractional ticks across frames. RTP clocks wrap at 32 bits.
                let previous = ticks(u128::from(previous), clock_rate);
                let current = ticks(u128::from(current), clock_rate);
                current.wrapping_sub(previous).max(1)
            }
            // A restarted capture clock must not send RTP time backwards. Start
            // its new epoch one nominal frame after the previous encoded frame.
            _ => self.previous_duration,
        };
        self.previous_capture = timestamp_ns;
        self.previous_duration = ticks(duration.as_nanos(), clock_rate).max(1);
        advance
    }
}

fn ticks(nanoseconds: u128, clock_rate: u32) -> u32 {
    // Truncation is the RTP timestamp's specified modulo-2^32 arithmetic.
    (nanoseconds * u128::from(clock_rate) / 1_000_000_000) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use rtc::rtp::codec::h264::H264Payloader;

    #[test]
    fn resumed_frame_rtp_timestamp_includes_the_capture_gap() {
        let now = Instant::now();
        let mut packetizer = new_packetizer(
            now,
            1200,
            96,
            1,
            Box::<H264Payloader>::default(),
            Box::new(new_random_sequencer()),
            90_000,
        );
        let mut clock = SampleClock::default();
        let data = bytes::Bytes::from_static(&[0, 0, 0, 1, 0x65, 1]);
        let mut emitted = Vec::new();
        for timestamp in [
            10_000_000_000,
            10_033_333_333,
            11_033_333_333,
            11_066_666_666,
        ] {
            packetizer.skip_samples(clock.advance(
                Some(timestamp),
                Duration::from_nanos(33_333_333),
                90_000,
            ));
            emitted.push(packetizer.packetize(now, &data, 0).unwrap().remove(0));
        }
        let delta = |index: usize| {
            emitted[index]
                .header
                .timestamp
                .wrapping_sub(emitted[index - 1].header.timestamp)
        };
        assert_eq!(delta(1), 2999);
        assert_eq!(delta(2), 90_000);
        assert_eq!(delta(3), 3000);
        for frames in emitted.windows(2) {
            assert_eq!(
                frames[1]
                    .header
                    .sequence_number
                    .wrapping_sub(frames[0].header.sequence_number),
                1
            );
        }
    }

    #[test]
    fn clock_restart_and_duration_only_samples_remain_monotonic() {
        let mut clock = SampleClock::default();
        let duration = Duration::from_millis(20);
        assert_eq!(clock.advance(Some(5_000_000_000), duration, 90_000), 0);
        assert_eq!(clock.advance(Some(0), duration, 90_000), 1800);
        assert_eq!(clock.advance(Some(100_000_000), duration, 90_000), 9000);
        assert_eq!(clock.advance(None, duration, 90_000), 1800);
        assert_eq!(clock.advance(None, duration, 90_000), 1800);
    }
}
