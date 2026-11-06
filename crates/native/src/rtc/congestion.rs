//! Send-side GCC wiring and encoder bitrate selection.
//!
//! `configure_congestion_control` takes the estimator by value into the interceptor
//! chain. [`ReportingEstimator`] wraps GCC and publishes its target on a `watch`
//! channel so the capture worker can retarget the hardware encoder. That pattern
//! matches the upstream webrtc-rs bandwidth-estimation example.

use std::time::Instant;

use rtc::interceptor::{BandwidthEstimator, EstimatorStats, Gcc, PacketReport};
use tokio::sync::watch;

/// Floor applied to encoder targets (bits/sec). Matches GCC's default floor.
pub const MIN_BITRATE_BPS: u32 = 100_000;

/// Starting encoder target before TWCC feedback arrives (bits/sec).
pub const INITIAL_BITRATE_BPS: u32 = 8_000_000;

/// Relative change required before calling into a live encoder again.
const MIN_CHANGE_RATIO: f64 = 0.10;

/// Minimum absolute change, in addition to the relative threshold.
const MIN_CHANGE_BPS: u32 = 50_000;

/// Delegates to `inner` and publishes its target after every update.
pub(super) struct ReportingEstimator<E: BandwidthEstimator> {
    inner: E,
    target: watch::Sender<f64>,
}

impl<E: BandwidthEstimator> ReportingEstimator<E> {
    pub(super) fn new(inner: E) -> (Self, watch::Receiver<f64>) {
        let (target, target_rx) = watch::channel(inner.target_bitrate());
        (Self { inner, target }, target_rx)
    }

    fn publish(&self) {
        self.target.send_replace(self.inner.target_bitrate());
    }
}

impl<E: BandwidthEstimator> BandwidthEstimator for ReportingEstimator<E> {
    fn on_reports(&mut self, now: Instant, reports: &[PacketReport]) {
        self.inner.on_reports(now, reports);
        self.publish();
    }

    fn target_bitrate(&self) -> f64 {
        self.inner.target_bitrate()
    }

    fn handle_timeout(&mut self, now: Instant) {
        self.inner.handle_timeout(now);
        self.publish();
    }

    fn poll_timeout(&self) -> Option<Instant> {
        self.inner.poll_timeout()
    }

    fn stats(&self) -> EstimatorStats {
        self.inner.stats()
    }
}

/// Start GCC at the desktop budget (8 Mb/s), with a 100 Mb/s ceiling. The capture worker
/// clamps published targets to the stream's configured ceiling before calling
/// the encoder; the peer is created before desktop settings are known.
pub(super) fn reporting_gcc() -> (ReportingEstimator<Gcc>, watch::Receiver<f64>) {
    ReportingEstimator::new(Gcc::new(
        f64::from(INITIAL_BITRATE_BPS),
        f64::from(MIN_BITRATE_BPS),
        100_000_000.0,
    ))
}

/// Pure controller: maps a bandwidth estimate onto an encoder target ≤ ceiling.
#[derive(Debug, Clone)]
pub struct BitrateController {
    ceiling_bps: u32,
    floor_bps: u32,
    applied_bps: u32,
    /// Whether the encoder can retarget without recreation.
    live_adaptation: bool,
}

impl BitrateController {
    /// Create a controller whose targets stay within `floor..=ceiling`.
    #[must_use]
    pub fn new(ceiling_bps: u32) -> Self {
        let ceiling_bps = ceiling_bps.max(1);
        let floor_bps = MIN_BITRATE_BPS.min(ceiling_bps).max(1);
        let applied_bps = INITIAL_BITRATE_BPS.clamp(floor_bps, ceiling_bps);
        Self {
            ceiling_bps,
            floor_bps,
            applied_bps,
            live_adaptation: true,
        }
    }

    #[must_use]
    pub fn ceiling_bps(&self) -> u32 {
        self.ceiling_bps
    }

    #[must_use]
    pub fn applied_bps(&self) -> u32 {
        self.applied_bps
    }

    #[must_use]
    pub fn live_adaptation(&self) -> bool {
        self.live_adaptation
    }

    /// Encoder open target before the first TWCC-driven update.
    #[must_use]
    pub fn encoder_open_bitrate_bps(&self) -> u32 {
        self.applied_bps
    }

    /// Clamp `estimate_bps` into the allowed range and return a new target when
    /// the change is large enough to warrant calling the encoder.
    pub fn observe_estimate(&mut self, estimate_bps: f64) -> Option<u32> {
        if !self.live_adaptation {
            return None;
        }
        let estimate = if estimate_bps.is_finite() && estimate_bps > 0.0 {
            estimate_bps
        } else {
            return None;
        };
        let target = (estimate as u32).clamp(self.floor_bps, self.ceiling_bps);
        if !should_retarget(self.applied_bps, target) {
            return None;
        }
        self.applied_bps = target;
        Some(target)
    }

    /// A device without live retargeting is recreated once at the current
    /// target, then capture admission provides backpressure at that fixed rate.
    pub fn disable_live_adaptation(&mut self) {
        self.live_adaptation = false;
    }
}

fn should_retarget(applied: u32, target: u32) -> bool {
    if applied == target {
        return false;
    }
    let delta = applied.abs_diff(target);
    if delta < MIN_CHANGE_BPS {
        return false;
    }
    let baseline = applied.max(1) as f64;
    (delta as f64) / baseline >= MIN_CHANGE_RATIO
}

/// Select the adaptive ceiling from desktop stream settings.
///
/// `bitrate_bps` is the configured maximum average rate (default 8 Mbps). When
/// `max_bitrate_bps` is non-zero it is the hard peak and becomes the ceiling.
#[must_use]
pub fn bitrate_ceiling(bitrate_bps: u32, max_bitrate_bps: u32) -> u32 {
    if max_bitrate_bps == 0 {
        bitrate_bps
    } else {
        max_bitrate_bps.max(bitrate_bps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_estimate_to_ceiling_and_floor() {
        let mut controller = BitrateController::new(8_000_000);
        assert_eq!(controller.encoder_open_bitrate_bps(), INITIAL_BITRATE_BPS);
        assert_eq!(controller.observe_estimate(20_000_000.0), None);
        assert_eq!(controller.applied_bps(), 8_000_000);
        assert_eq!(controller.observe_estimate(1_000.0), Some(MIN_BITRATE_BPS));
    }

    #[test]
    fn ignores_small_jitter_around_applied_rate() {
        let mut controller = BitrateController::new(8_000_000);
        assert_eq!(controller.observe_estimate(2_000_000.0), Some(2_000_000));
        assert_eq!(controller.observe_estimate(2_040_000.0), None);
        assert_eq!(controller.observe_estimate(2_300_000.0), Some(2_300_000));
    }

    #[test]
    fn preview_ceiling_keeps_targets_inside_budget() {
        let mut controller = BitrateController::new(150_000);
        assert_eq!(controller.encoder_open_bitrate_bps(), 150_000);
        assert_eq!(controller.floor_bps, MIN_BITRATE_BPS.min(150_000));
        assert_eq!(controller.observe_estimate(80_000.0), Some(MIN_BITRATE_BPS));
        assert_eq!(controller.observe_estimate(400_000.0), Some(150_000));
    }

    #[test]
    fn unsupported_retarget_does_not_jump_to_ceiling() {
        let mut controller = BitrateController::new(8_000_000);
        assert_eq!(controller.observe_estimate(1_000_000.0), Some(1_000_000));
        controller.disable_live_adaptation();
        assert!(!controller.live_adaptation());
        assert_eq!(controller.observe_estimate(8_000_000.0), None);
        assert_eq!(controller.encoder_open_bitrate_bps(), 1_000_000);
    }

    #[test]
    fn startup_estimator_matches_encoder_and_small_steps_do_not_reconfigure() {
        let (_, receiver) = reporting_gcc();
        let mut controller = BitrateController::new(8_000_000);
        assert_eq!(
            *receiver.borrow(),
            f64::from(controller.encoder_open_bitrate_bps())
        );
        assert_eq!(controller.observe_estimate(7_900_000.0), None);
        assert_eq!(controller.observe_estimate(7_000_000.0), Some(7_000_000));
    }

    #[test]
    fn bitrate_ceiling_prefers_explicit_max() {
        assert_eq!(bitrate_ceiling(8_000_000, 0), 8_000_000);
        assert_eq!(bitrate_ceiling(4_000_000, 8_000_000), 8_000_000);
        assert_eq!(bitrate_ceiling(8_000_000, 8_000_000), 8_000_000);
    }

    #[test]
    fn rejects_non_finite_estimates() {
        let mut controller = BitrateController::new(8_000_000);
        assert_eq!(controller.observe_estimate(f64::NAN), None);
        assert_eq!(controller.observe_estimate(f64::INFINITY), None);
        assert_eq!(controller.observe_estimate(0.0), None);
    }
}
