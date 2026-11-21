//! Receiver-side video statistics for the controls' Monitor panel.
//!
//! The receive loop feeds every RTP packet into a [`Meter`] and publishes one
//! [`StreamStats`] sample per second. One peer runs per viewer process, so a
//! process-wide watch channel is the boundary between transport and controls.

use std::collections::VecDeque;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use tokio::sync::watch;

/// Bitrate samples kept for the Monitor sparkline, oldest first.
pub(crate) const HISTORY: usize = 30;
/// Every negotiated video codec (H.264, HEVC, AV1) uses a 90 kHz RTP clock.
const CLOCK_RATE: f64 = 90_000.;

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct StreamStats {
    /// At least one frame has been decoded on the current peer.
    pub(crate) live: bool,
    pub(crate) bitrate_bps: u64,
    pub(crate) fps: f32,
    /// Fraction of expected packets missing during the last interval.
    pub(crate) packet_loss: f32,
    pub(crate) packets_lost: u64,
    /// RFC 3550 interarrival jitter.
    pub(crate) jitter_ms: f32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    /// Decoded frames replaced before presentation could commit them.
    pub(crate) skipped_frames: u64,
    pub(crate) keyframe_requests: u64,
    pub(crate) history: Vec<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Quality {
    Waiting,
    Good,
    Fair,
    Poor,
}

impl StreamStats {
    /// Network health only; frame rate follows the remote screen's activity.
    pub(crate) fn quality(&self) -> Quality {
        if !self.live {
            Quality::Waiting
        } else if self.packet_loss >= 0.05 || self.jitter_ms >= 60. {
            Quality::Poor
        } else if self.packet_loss >= 0.01 || self.jitter_ms >= 25. {
            Quality::Fair
        } else {
            Quality::Good
        }
    }
}

static STATS: LazyLock<watch::Sender<StreamStats>> =
    LazyLock::new(|| watch::channel(StreamStats::default()).0);

pub(crate) fn subscribe() -> watch::Receiver<StreamStats> {
    STATS.subscribe()
}

pub(crate) fn publish(stats: StreamStats) {
    STATS.send_replace(stats);
}

/// Decoder-side totals sampled alongside the packet counters.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct DecodeTotals {
    pub(crate) decoded: u64,
    pub(crate) size: (u32, u32),
    pub(crate) skipped: u64,
    pub(crate) keyframe_requests: u64,
}

#[derive(Debug)]
pub(crate) struct Meter {
    sampled_at: Instant,
    bytes: u64,
    received: u64,
    /// Extended highest sequence number; offset by one cycle so the first
    /// interval's base cannot underflow.
    highest: Option<u64>,
    base: u64,
    previous: Option<(Instant, u32)>,
    jitter: f64,
    lost: u64,
    decoded: u64,
    history: VecDeque<u64>,
}

impl Meter {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            sampled_at: now,
            bytes: 0,
            received: 0,
            highest: None,
            base: 0,
            previous: None,
            jitter: 0.,
            lost: 0,
            decoded: 0,
            history: VecDeque::with_capacity(HISTORY),
        }
    }

    pub(crate) fn packet(&mut self, len: usize, sequence: u16, timestamp: u32, at: Instant) {
        self.bytes += len as u64;
        self.received += 1;
        match self.highest {
            None => {
                let extended = u64::from(sequence) + (1 << 16);
                self.highest = Some(extended);
                self.base = extended - 1;
            }
            Some(highest) => {
                let delta = i64::from(sequence.wrapping_sub(highest as u16) as i16);
                let extended = (highest as i64 + delta).max(0) as u64;
                self.highest = Some(highest.max(extended));
            }
        }
        if let Some((previous_at, previous_timestamp)) = self.previous {
            let arrival = at.saturating_duration_since(previous_at).as_secs_f64() * CLOCK_RATE;
            let sent = f64::from(timestamp.wrapping_sub(previous_timestamp) as i32);
            self.jitter += ((arrival - sent).abs() - self.jitter) / 16.;
        }
        self.previous = Some((at, timestamp));
    }

    pub(crate) fn sample(&mut self, now: Instant, totals: DecodeTotals) -> StreamStats {
        let elapsed = now
            .saturating_duration_since(self.sampled_at)
            .max(Duration::from_millis(1))
            .as_secs_f64();
        let expected = self.highest.map_or(0, |highest| highest - self.base);
        let lost = expected.saturating_sub(self.received);
        self.lost += lost;
        let bitrate = (self.bytes as f64 * 8. / elapsed) as u64;
        let frames = totals.decoded.saturating_sub(self.decoded);
        if self.history.len() == HISTORY {
            self.history.pop_front();
        }
        self.history.push_back(bitrate);
        let stats = StreamStats {
            live: totals.decoded > 0,
            bitrate_bps: bitrate,
            fps: (frames as f64 / elapsed) as f32,
            packet_loss: if expected == 0 {
                0.
            } else {
                lost as f32 / expected as f32
            },
            packets_lost: self.lost,
            jitter_ms: (self.jitter / CLOCK_RATE * 1000.) as f32,
            width: totals.size.0,
            height: totals.size.1,
            skipped_frames: totals.skipped,
            keyframe_requests: totals.keyframe_requests,
            history: self.history.iter().copied().collect(),
        };
        self.sampled_at = now;
        self.bytes = 0;
        self.received = 0;
        self.base = self.highest.unwrap_or(0);
        self.decoded = totals.decoded;
        stats
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn totals(decoded: u64) -> DecodeTotals {
        DecodeTotals {
            decoded,
            size: (1920, 1080),
            ..DecodeTotals::default()
        }
    }

    #[test]
    fn steady_stream_reports_rate_without_loss_or_jitter() {
        let start = Instant::now();
        let mut meter = Meter::new(start);
        // 30 frames per second, one 1,250-byte packet per frame.
        for frame in 0..30_u32 {
            let at = start + Duration::from_millis(u64::from(frame) * 1000 / 30);
            meter.packet(1250, frame as u16, frame * 3000, at);
        }
        let stats = meter.sample(start + Duration::from_secs(1), totals(30));
        assert_eq!(stats.bitrate_bps, 300_000);
        assert!((stats.fps - 30.).abs() < 0.01);
        assert_eq!(stats.packet_loss, 0.);
        assert!(stats.jitter_ms < 1., "jitter {}", stats.jitter_ms);
        assert_eq!(stats.quality(), Quality::Good);
        assert_eq!(stats.history, vec![300_000]);
    }

    #[test]
    fn gaps_across_sequence_wrap_count_as_loss_in_their_interval() {
        let start = Instant::now();
        let mut meter = Meter::new(start);
        for (index, sequence) in [65_530_u16, 65_531, 65_534, 65_535, 0, 2, 3]
            .into_iter()
            .enumerate()
        {
            meter.packet(
                100,
                sequence,
                0,
                start + Duration::from_millis(index as u64),
            );
        }
        // 65530..=3 expects 10 packets; 7 arrived.
        let stats = meter.sample(start + Duration::from_secs(1), totals(1));
        assert_eq!(stats.packets_lost, 3);
        assert!((stats.packet_loss - 0.3).abs() < 1e-6);
        assert_eq!(stats.quality(), Quality::Poor);
        meter.packet(100, 4, 0, start + Duration::from_millis(1001));
        let next = meter.sample(start + Duration::from_secs(2), totals(2));
        assert_eq!(next.packet_loss, 0.);
        assert_eq!(next.packets_lost, 3);
    }

    #[test]
    fn late_and_duplicate_packets_never_report_negative_loss() {
        let start = Instant::now();
        let mut meter = Meter::new(start);
        for sequence in [10_u16, 12, 11, 11, 13] {
            meter.packet(100, sequence, 0, start);
        }
        let stats = meter.sample(start + Duration::from_secs(1), totals(1));
        assert_eq!(stats.packet_loss, 0.);
        assert_eq!(stats.packets_lost, 0);
    }

    #[test]
    fn irregular_arrival_raises_jitter() {
        let start = Instant::now();
        let mut meter = Meter::new(start);
        for frame in 0..60_u32 {
            // Alternate 0 ms and 66 ms gaps for frames sent 33 ms apart.
            let at = start + Duration::from_millis(u64::from(frame / 2) * 66);
            meter.packet(1000, frame as u16, frame * 3000, at);
        }
        let stats = meter.sample(start + Duration::from_secs(2), totals(60));
        assert!(stats.jitter_ms > 25., "jitter {}", stats.jitter_ms);
        assert_eq!(stats.quality(), Quality::Fair);
    }

    #[test]
    fn history_keeps_the_most_recent_samples() {
        let start = Instant::now();
        let mut meter = Meter::new(start);
        let mut stats = StreamStats::default();
        for second in 1..=(HISTORY as u64 + 5) {
            meter.packet(second as usize, second as u16, 0, start);
            stats = meter.sample(start + Duration::from_secs(second), totals(second));
        }
        assert_eq!(stats.history.len(), HISTORY);
        assert_eq!(stats.history.last(), Some(&((HISTORY as u64 + 5) * 8)));
        assert!(!StreamStats::default().live);
        assert_eq!(StreamStats::default().quality(), Quality::Waiting);
    }
}
