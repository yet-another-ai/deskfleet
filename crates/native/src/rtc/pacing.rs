//! Packet pacing with backpressure at complete media-sample boundaries.
//!
//! The upstream pacer accepts packets immediately and drops new packets when
//! its FIFO fills. Waiting for the final packet's release instead keeps each
//! track to one in-flight sample, including IDRs larger than that FIFO.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rtc::interceptor::{
    Attribute, Interceptor, PacerBuilder, PacerInterceptor, Packet, StreamInfo, TaggedPacket,
};
use rtc::sansio::Protocol;
use rtc::shared::marshal::MarshalSize;
use tokio::sync::oneshot;
use webrtc::error::Error;

/// A frame is encoded at the estimated average rate; pacing needs room for
/// keyframes, RTP overhead and the encoder's delayed reaction to feedback.
const PACING_FACTOR: f64 = 2.5;
const MAX_PENDING_TIME: Duration = Duration::from_millis(150);

struct Receipt {
    sequence: u16,
    released: oneshot::Sender<()>,
}

struct State {
    receipts: HashMap<u32, Receipt>,
    pending_bytes: usize,
    oldest: Option<Instant>,
    pacing_bps: f64,
}

/// Shared only by one peer's media tracks and capture worker.
#[derive(Clone)]
pub(super) struct PacingHandle(Arc<Mutex<State>>);

impl PacingHandle {
    /// Register before writing the sample's packets. The sample track holds its
    /// packetizer lock until this receipt resolves, so one waiter per SSRC is enough.
    pub(super) fn prepare_sample(&self, ssrc: u32, last_sequence: u16) -> oneshot::Receiver<()> {
        let (released, receipt) = oneshot::channel();
        self.0
            .lock()
            .expect("pacing state poisoned")
            .receipts
            .insert(
                ssrc,
                Receipt {
                    sequence: last_sequence,
                    released,
                },
            );
        receipt
    }

    /// Pause raw-frame submission, preserving the encoded reference chain. Both
    /// queued duration and actual age matter when feedback cuts the send rate.
    pub(super) fn is_congested(&self) -> bool {
        let state = self.0.lock().expect("pacing state poisoned");
        state.pending_bytes as f64 * 8.0 / state.pacing_bps >= MAX_PENDING_TIME.as_secs_f64()
            || state
                .oldest
                .is_some_and(|oldest| oldest.elapsed() >= MAX_PENDING_TIME)
    }
}

/// Owns the upstream token bucket; no codec parsing or RTP reordering is added.
/// Install at `Slot::Pacer`, before TWCC numbering and send-history recording.
pub(super) struct DesktopPacer {
    inner: PacerInterceptor,
    handle: PacingHandle,
    queued: VecDeque<(usize, Instant)>,
}

impl DesktopPacer {
    pub(super) fn new(initial_bps: f64) -> (Self, PacingHandle) {
        let pacing_bps = pacing_rate(initial_bps);
        let handle = PacingHandle(Arc::new(Mutex::new(State {
            receipts: HashMap::new(),
            pending_bytes: 0,
            oldest: None,
            pacing_bps,
        })));
        (
            Self {
                inner: PacerBuilder::new()
                    .with_target_bitrate(pacing_bps)
                    // Complete-sample backpressure bounds original media. A
                    // fixed RTP count can truncate a single high-detail IDR.
                    .with_queue_limit(usize::MAX)
                    .build(),
                handle: handle.clone(),
                queued: VecDeque::new(),
            },
            handle,
        )
    }
}

impl Drop for DesktopPacer {
    fn drop(&mut self) {
        // The peer can still own the handle after its transport driver exits.
        // Close pending receipts so their writers do not wait for absent timers.
        let mut state = self.handle.0.lock().expect("pacing state poisoned");
        state.receipts.clear();
        state.pending_bytes = 0;
        state.oldest = None;
    }
}

fn pacing_rate(target: f64) -> f64 {
    (target * PACING_FACTOR).max(1.0)
}

impl Protocol<TaggedPacket, TaggedPacket, ()> for DesktopPacer {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = Error;
    type Time = Instant;

    fn handle_read(&mut self, message: TaggedPacket) -> Result<(), Error> {
        let target = match message.message.get(&Attribute::TargetBitrateChanged {
            bits_per_second: 0.0,
        }) {
            Some(Attribute::TargetBitrateChanged { bits_per_second }) => Some(*bits_per_second),
            _ => None,
        };
        // Settle elapsed time at the old rate before applying the new estimate.
        self.inner.pacer_mut().refill(message.now);
        self.inner.handle_read(message)?;
        if let Some(target) = target {
            let rate = pacing_rate(target);
            self.inner.pacer_mut().set_target_bitrate(rate);
            self.handle
                .0
                .lock()
                .expect("pacing state poisoned")
                .pacing_bps = rate;
        }
        Ok(())
    }

    fn poll_read(&mut self) -> Option<TaggedPacket> {
        self.inner.poll_read()
    }

    fn handle_write(&mut self, message: TaggedPacket) -> Result<(), Error> {
        if let Packet::Rtp(packet) = &message.message.packet {
            let bytes = packet.marshal_size();
            let mut state = self.handle.0.lock().expect("pacing state poisoned");
            // NACK retries bypass sample backpressure. Do not let repeated
            // requests grow an additional FIFO behind an already late frame.
            // Original samples are always accepted in full.
            if message.message.has(&Attribute::Retransmission)
                && (state.pending_bytes + bytes) as f64 * 8.0 / state.pacing_bps
                    >= MAX_PENDING_TIME.as_secs_f64()
            {
                return Ok(());
            }
            self.queued.push_back((bytes, message.now));
            state.pending_bytes += bytes;
            state.oldest = self.queued.front().map(|(_, at)| *at);
        }
        self.inner.handle_write(message)
    }

    fn poll_write(&mut self) -> Option<TaggedPacket> {
        let message = self.inner.poll_write()?;
        if let Packet::Rtp(packet) = &message.message.packet {
            let (bytes, _) = self.queued.pop_front().expect("released packet was queued");
            let mut state = self.handle.0.lock().expect("pacing state poisoned");
            state.pending_bytes -= bytes;
            state.oldest = self.queued.front().map(|(_, at)| *at);
            if !message.message.has(&Attribute::Retransmission)
                && state
                    .receipts
                    .get(&packet.header.ssrc)
                    .is_some_and(|receipt| receipt.sequence == packet.header.sequence_number)
                && let Some(receipt) = state.receipts.remove(&packet.header.ssrc)
            {
                let _ = receipt.released.send(());
            }
        }
        Some(message)
    }

    fn handle_timeout(&mut self, now: Instant) -> Result<(), Error> {
        self.inner.handle_timeout(now)
    }

    fn poll_timeout(&mut self) -> Option<Instant> {
        self.inner.poll_timeout()
    }
}

impl Interceptor for DesktopPacer {
    fn bind_local_stream(&mut self, info: &StreamInfo) {
        self.inner.bind_local_stream(info);
    }
    fn unbind_local_stream(&mut self, info: &StreamInfo) {
        self.inner.unbind_local_stream(info);
    }
    fn bind_remote_stream(&mut self, info: &StreamInfo) {
        self.inner.bind_remote_stream(info);
    }
    fn unbind_remote_stream(&mut self, info: &StreamInfo) {
        self.inner.unbind_remote_stream(info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rtc::interceptor::AttributedPacket;
    use rtc::rtp::{header::Header, packet::Packet as RtpPacket};
    use rtc::shared::TransportContext;

    fn packet(now: Instant, sequence: u16) -> TaggedPacket {
        TaggedPacket {
            now,
            transport: TransportContext::default(),
            message: AttributedPacket::new(Packet::Rtp(RtpPacket {
                header: Header {
                    version: 2,
                    ssrc: 1,
                    sequence_number: sequence,
                    ..Default::default()
                },
                payload: vec![0; 1188].into(),
            })),
        }
    }

    #[test]
    fn receipt_waits_for_final_packet_departure_and_preserves_release_time() {
        let now = Instant::now();
        let (mut pacer, handle) = DesktopPacer::new(100_000.0);
        let mut receipt = handle.prepare_sample(1, 9);
        for sequence in 0..10 {
            pacer.handle_write(packet(now, sequence)).unwrap();
        }
        assert!(handle.is_congested());
        pacer.handle_timeout(now).unwrap();
        assert!(pacer.poll_write().is_some());
        assert!(pacer.poll_write().is_some());
        assert!(pacer.poll_write().is_none());
        assert!(matches!(
            receipt.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        let mut departed = 2;
        while let Some(deadline) = pacer.poll_timeout() {
            pacer
                .handle_timeout(deadline + Duration::from_nanos(1))
                .unwrap();
            while let Some(message) = pacer.poll_write() {
                assert!(message.now >= deadline);
                departed += 1;
            }
        }
        assert_eq!(departed, 10);
        assert_eq!(receipt.try_recv(), Ok(()));
        assert!(!handle.is_congested());
    }

    #[test]
    fn large_idr_is_not_truncated_at_the_upstream_packet_limit() {
        let now = Instant::now();
        let (mut pacer, handle) = DesktopPacer::new(8_000_000.0);
        let mut receipt = handle.prepare_sample(1, 4_199);
        for sequence in 0..4_200 {
            pacer.handle_write(packet(now, sequence)).unwrap();
        }
        let mut departed = 0;
        while let Some(deadline) = pacer.poll_timeout() {
            pacer
                .handle_timeout(deadline + Duration::from_nanos(1))
                .unwrap();
            while pacer.poll_write().is_some() {
                departed += 1;
            }
        }
        assert_eq!(departed, 4_200);
        assert_eq!(receipt.try_recv(), Ok(()));
        assert_eq!(pacer.inner.dropped(), 0);
    }

    #[test]
    fn feedback_applies_headroom_and_rtcp_bypasses_media_backlog() {
        let now = Instant::now();
        let (mut pacer, _) = DesktopPacer::new(8_000_000.0);
        assert_eq!(pacer.inner.pacer().target_bitrate(), 20_000_000.0);
        let feedback = || TaggedPacket {
            now,
            transport: TransportContext::default(),
            message: AttributedPacket::new(Packet::Rtcp(vec![])).with(
                Attribute::TargetBitrateChanged {
                    bits_per_second: 1_000_000.0,
                },
            ),
        };
        pacer.handle_read(feedback()).unwrap();
        assert_eq!(pacer.inner.pacer().target_bitrate(), 2_500_000.0);
        pacer.handle_write(packet(now, 1)).unwrap();
        pacer.handle_write(feedback()).unwrap();
        assert!(matches!(
            pacer.poll_write().unwrap().message.packet,
            Packet::Rtcp(_)
        ));
    }

    #[test]
    fn nack_retries_cannot_build_another_backlog_behind_an_idr() {
        let now = Instant::now();
        let (mut pacer, handle) = DesktopPacer::new(100_000.0);
        for sequence in 0..10 {
            pacer.handle_write(packet(now, sequence)).unwrap();
        }
        assert!(handle.is_congested());
        let before = handle.0.lock().unwrap().pending_bytes;
        for sequence in 0..100 {
            let mut retry = packet(now, sequence);
            retry.message.add(Attribute::Retransmission);
            pacer.handle_write(retry).unwrap();
        }
        assert_eq!(handle.0.lock().unwrap().pending_bytes, before);
        assert_eq!(pacer.queued.len(), 10);
    }

    #[test]
    fn driver_teardown_cancels_receipts_even_while_the_peer_retains_its_handle() {
        let now = Instant::now();
        let (mut pacer, handle) = DesktopPacer::new(100_000.0);
        let mut receipt = handle.prepare_sample(1, 1);
        pacer.handle_write(packet(now, 1)).unwrap();
        drop(pacer);
        assert_eq!(
            receipt.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        );
        assert!(!handle.is_congested());
    }

    #[test]
    fn retransmission_cannot_complete_a_new_sample_receipt() {
        let now = Instant::now();
        let (mut pacer, handle) = DesktopPacer::new(8_000_000.0);
        let mut receipt = handle.prepare_sample(1, 1);
        let mut retry = packet(now, 1);
        retry.message.add(Attribute::Retransmission);
        pacer.handle_write(retry).unwrap();
        pacer.handle_timeout(now).unwrap();
        assert!(pacer.poll_write().is_some());
        assert!(matches!(
            receipt.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        pacer.handle_write(packet(now, 1)).unwrap();
        pacer.handle_timeout(now).unwrap();
        assert!(pacer.poll_write().is_some());
        assert_eq!(receipt.try_recv(), Ok(()));
    }
}
