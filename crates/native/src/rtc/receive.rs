//! Single-consumer video transport. Reordering and codec depacketization belong
//! to the decoder pipeline; this boundary never drops compressed interframes.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use bytes::Bytes;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::shared::marshal::Marshal;
use tokio::sync::{oneshot, watch};
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};

use super::{PeerError, Result, VideoCodec};

/// One complete RTP datagram, including its header, for a decoder's RTP source.
/// Sequence numbers and timestamps retain their on-the-wire wrapping values.
#[derive(Debug)]
pub struct ReceivedVideoPacket {
    pub data: Bytes,
    pub sequence_number: u16,
    pub timestamp: u32,
    pub ssrc: u32,
    pub payload_type: u8,
    pub marker: bool,
    /// Time this consumer read the packet, not a kernel receive timestamp.
    pub received_at: Instant,
}

/// An independently owned, single-consumer receive-only video track.
///
/// Read packets continuously on the transport/decoder task, independently of
/// presentation backpressure. No extra media queue is inserted here. Closing
/// or dropping the owning peer cancels reads, including before the first track.
pub struct VideoReceiver {
    pending_track: Option<oneshot::Receiver<Arc<dyn TrackRemote>>>,
    track: Option<Arc<dyn TrackRemote>>,
    closed: watch::Receiver<bool>,
    codec: VideoCodec,
    ssrc: Option<u32>,
    ended: bool,
}

pub(super) struct IncomingVideo(Mutex<Option<oneshot::Sender<Arc<dyn TrackRemote>>>>);

pub(super) fn channel(
    codec: VideoCodec,
    closed: watch::Receiver<bool>,
) -> (IncomingVideo, VideoReceiver) {
    let (sender, receiver) = oneshot::channel();
    (
        IncomingVideo(Mutex::new(Some(sender))),
        VideoReceiver {
            pending_track: Some(receiver),
            track: None,
            closed,
            codec,
            ssrc: None,
            ended: false,
        },
    )
}

impl IncomingVideo {
    pub(super) fn accept(&self, track: Arc<dyn TrackRemote>) {
        if let Some(sender) = self
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            let _ = sender.send(track);
        }
    }
}

impl VideoReceiver {
    pub fn codec(&self) -> VideoCodec {
        self.codec
    }

    /// Read a packet without applying a presentation clock or discarding an
    /// encoded frame. Returns `None` after the track or owning peer ends.
    /// Cancelling this future before it resolves does not discard a packet.
    pub async fn next_packet(&mut self) -> Result<Option<ReceivedVideoPacket>> {
        if self.ended || *self.closed.borrow() {
            return Ok(None);
        }
        if let Some(pending) = &mut self.pending_track {
            let track = tokio::select! {
                biased;
                _ = self.closed.changed() => return Ok(None),
                track = pending => track.map_err(|_| PeerError::VideoReceive("video track was not delivered"))?,
            };
            self.track = Some(track);
            self.pending_track = None;
        }
        let track = self
            .track
            .as_ref()
            .ok_or(PeerError::VideoReceive("video track is unavailable"))?;
        loop {
            let event = tokio::select! {
                biased;
                _ = self.closed.changed() => return Ok(None),
                event = track.poll() => event,
            };
            match event {
                Some(TrackRemoteEvent::OnRtpPacket(packet)) => {
                    self.ssrc = Some(packet.header.ssrc);
                    return Ok(Some(ReceivedVideoPacket {
                        data: packet.marshal()?.freeze(),
                        sequence_number: packet.header.sequence_number,
                        timestamp: packet.header.timestamp,
                        ssrc: packet.header.ssrc,
                        payload_type: packet.header.payload_type,
                        marker: packet.header.marker,
                        received_at: Instant::now(),
                    }));
                }
                Some(TrackRemoteEvent::OnError) => {
                    self.ended = true;
                    return Err(PeerError::VideoReceive("remote video track failed"));
                }
                None | Some(TrackRemoteEvent::OnEnding | TrackRemoteEvent::OnEnded) => {
                    self.ended = true;
                    return Ok(None);
                }
                _ => {}
            }
        }
    }

    /// Request a decoder refresh after loss or a decode failure. The first RTP
    /// packet must have been read so its SSRC identifies the remote sender.
    pub async fn request_keyframe(&self) -> Result<()> {
        if self.ended || *self.closed.borrow() {
            return Err(PeerError::Closed);
        }
        let track = self
            .track
            .as_ref()
            .ok_or(PeerError::MissingTrack("received video"))?;
        let ssrc = self.ssrc.ok_or(PeerError::MissingTrack("received video"))?;
        track
            .write_rtcp(vec![Box::new(PictureLossIndication {
                sender_ssrc: 0,
                media_ssrc: ssrc,
            })])
            .await?;
        Ok(())
    }
}
