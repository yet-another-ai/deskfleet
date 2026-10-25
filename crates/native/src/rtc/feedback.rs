use std::collections::VecDeque;
use std::time::Instant;

use rtc::interceptor::{Attribute, Interceptor, Packet, StreamInfo, TaggedPacket};
use rtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::sansio::Protocol;
use webrtc::error::Error;

/// Let the application answer keyframe requests after the standard interceptors
/// have consumed NACKs, reports and transport feedback. The new RTC core stops
/// inbound RTCP at the interceptor boundary unless explicitly marked here.
#[derive(Default)]
pub(super) struct KeyframeFeedback {
    reads: VecDeque<TaggedPacket>,
    writes: VecDeque<TaggedPacket>,
}

pub(super) fn is_keyframe_request(packet: &dyn rtc::rtcp::Packet) -> bool {
    packet.as_any().is::<PictureLossIndication>() || packet.as_any().is::<FullIntraRequest>()
}

impl Protocol<TaggedPacket, TaggedPacket, ()> for KeyframeFeedback {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = Error;
    type Time = Instant;

    fn handle_read(&mut self, mut message: TaggedPacket) -> Result<(), Error> {
        if let Packet::Rtcp(packets) = &mut message.message.packet {
            packets.retain(|packet| is_keyframe_request(packet.as_ref()));
            if packets.is_empty() {
                return Ok(());
            }
            message.message.add(Attribute::DeliverToApplication);
        }
        self.reads.push_back(message);
        Ok(())
    }

    fn poll_read(&mut self) -> Option<TaggedPacket> {
        self.reads.pop_front()
    }

    fn handle_write(&mut self, message: TaggedPacket) -> Result<(), Error> {
        self.writes.push_back(message);
        Ok(())
    }

    fn poll_write(&mut self) -> Option<TaggedPacket> {
        self.writes.pop_front()
    }
}

impl Interceptor for KeyframeFeedback {
    fn bind_local_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_local_stream(&mut self, _info: &StreamInfo) {}
    fn bind_remote_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_remote_stream(&mut self, _info: &StreamInfo) {}
}
