//! On-demand machine CPU, memory, and battery sampling, independent of display
//! access.

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use sysinfo::{MINIMUM_CPU_UPDATE_INTERVAL, System};

// Resume with a fresh baseline after a hidden panel stops polling. Otherwise the
// first CPU value would average over the entire time the panel was closed.
const MAX_CPU_SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
static COLLECTOR: Mutex<Option<Collector>> = Mutex::new(None);

/// One transient machine-level measurement. Memory values are bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct SystemStatus {
    /// Time at which this measurement was completed.
    pub sampled_at: SystemTime,
    /// Busy time averaged across logical CPUs, from 0 to 100.
    pub cpu_usage_percent: f32,
    /// RAM currently used according to the host operating system.
    pub memory_used_bytes: u64,
    /// Total physical RAM.
    pub memory_total_bytes: u64,
    /// Swap currently used.
    pub swap_used_bytes: u64,
    /// Total swap space; zero when swap is not configured.
    pub swap_total_bytes: u64,
    /// Model reported by the first logical CPU.
    pub cpu_model: String,
    /// Logical CPUs visible to the host sampler.
    pub logical_cpu_count: usize,
    /// Human-readable operating system name and version.
    pub os: String,
    /// Architecture of the running daemon.
    pub arch: &'static str,
    /// Time since the machine booted.
    pub uptime_seconds: u64,
    /// Remaining charge and power direction when the machine has batteries.
    pub battery: Option<BatteryStatus>,
}

/// Power direction reported by a battery controller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatteryState {
    Unknown,
    Charging,
    Discharging,
    Empty,
    Full,
    /// Connected to power but not charging, for example at a charge limit.
    Paused,
}

/// Aggregated battery charge and state for the machine.
#[derive(Debug, Clone, PartialEq)]
pub struct BatteryStatus {
    /// Remaining charge from 0 to 100.
    pub percent: f64,
    pub state: BatteryState,
}

/// Failures to run or synchronize the machine sampler.
#[derive(Debug, thiserror::Error)]
pub enum SystemStatusError {
    #[error("cannot read system status: {0}")]
    Read(#[from] sysinfo::Error),
    #[error("system status worker failed: {0}")]
    Worker(#[from] tokio::task::JoinError),
    #[error("system status collector is unavailable after a worker failure")]
    CollectorUnavailable,
}

struct Collector {
    system: System,
    previous: Option<(Instant, SystemStatus)>,
}

impl Collector {
    fn new() -> Result<Self, SystemStatusError> {
        Ok(Self {
            system: System::new()?,
            previous: None,
        })
    }

    fn sample(&mut self) -> Result<SystemStatus, SystemStatusError> {
        if let Some((at, snapshot)) = &self.previous
            && at.elapsed() < MINIMUM_CPU_UPDATE_INTERVAL
        {
            return Ok(snapshot.clone());
        }
        if self
            .previous
            .as_ref()
            .is_none_or(|(at, _)| at.elapsed() > MAX_CPU_SAMPLE_INTERVAL)
        {
            self.system.refresh_cpu_usage();
            std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
        }
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        let snapshot = SystemStatus {
            sampled_at: SystemTime::now(),
            cpu_usage_percent: self.system.global_cpu_usage(),
            memory_used_bytes: self.system.used_memory(),
            memory_total_bytes: self.system.total_memory(),
            swap_used_bytes: self.system.used_swap(),
            swap_total_bytes: self.system.total_swap(),
            cpu_model: self
                .system
                .cpus()
                .first()
                .map(|cpu| cpu.brand().to_owned())
                .unwrap_or_default(),
            logical_cpu_count: self.system.cpus().len(),
            os: System::long_os_version().unwrap_or_else(|_| std::env::consts::OS.to_owned()),
            arch: std::env::consts::ARCH,
            uptime_seconds: System::uptime()?,
            battery: read_battery(),
        };
        self.previous = Some((Instant::now(), snapshot.clone()));
        Ok(snapshot)
    }
}

/// One battery reading used to aggregate machines with several batteries.
#[derive(Debug, Clone, Copy)]
struct BatteryReading {
    percent: f64,
    full_energy: f64,
    state: BatteryState,
}

/// Aggregate per-battery readings without inventing a value when none exist.
///
/// Machines with several batteries report a capacity-weighted charge and the
/// strongest power direction: charging, then discharging, paused, empty, full.
fn summarize_battery(readings: impl IntoIterator<Item = BatteryReading>) -> Option<BatteryStatus> {
    let readings: Vec<_> = readings
        .into_iter()
        .filter(|reading| reading.percent.is_finite() && reading.percent >= 0.0)
        .collect();
    if readings.is_empty() {
        return None;
    }

    let total_full: f64 = readings
        .iter()
        .map(|reading| reading.full_energy)
        .filter(|energy| energy.is_finite() && *energy > 0.0)
        .sum();
    let percent = if total_full > 0.0 {
        readings
            .iter()
            .filter(|reading| reading.full_energy.is_finite() && reading.full_energy > 0.0)
            .map(|reading| reading.percent * reading.full_energy)
            .sum::<f64>()
            / total_full
    } else {
        readings.iter().map(|reading| reading.percent).sum::<f64>() / readings.len() as f64
    };

    let state = if readings
        .iter()
        .any(|reading| reading.state == BatteryState::Charging)
    {
        BatteryState::Charging
    } else if readings
        .iter()
        .any(|reading| reading.state == BatteryState::Discharging)
    {
        BatteryState::Discharging
    } else if readings
        .iter()
        .any(|reading| reading.state == BatteryState::Paused)
    {
        BatteryState::Paused
    } else if readings
        .iter()
        .any(|reading| reading.state == BatteryState::Empty)
    {
        BatteryState::Empty
    } else if readings
        .iter()
        .all(|reading| reading.state == BatteryState::Full)
    {
        BatteryState::Full
    } else {
        BatteryState::Unknown
    };

    Some(BatteryStatus {
        percent: percent.clamp(0.0, 100.0),
        state,
    })
}

/// Read the machine's batteries without failing the rest of the status sample.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn read_battery() -> Option<BatteryStatus> {
    let manager = starship_battery::Manager::new().ok()?;
    let batteries = manager.batteries().ok()?;
    summarize_battery(
        batteries
            .filter_map(|battery| battery.ok())
            .map(|battery| BatteryReading {
                percent: f64::from(battery.state_of_charge().value) * 100.0,
                full_energy: f64::from(battery.energy_full().value),
                state: match battery.state() {
                    starship_battery::State::Unknown => BatteryState::Unknown,
                    starship_battery::State::Charging => BatteryState::Charging,
                    starship_battery::State::Discharging => BatteryState::Discharging,
                    starship_battery::State::Empty => BatteryState::Empty,
                    starship_battery::State::Full => BatteryState::Full,
                    starship_battery::State::Paused => BatteryState::Paused,
                },
            }),
    )
}

/// Android and iOS viewers do not own a machine battery collector.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn read_battery() -> Option<BatteryStatus> {
    None
}

/// Read host CPU, memory, and battery state on a blocking worker, sharing one
/// sampler across viewers. The first read primes CPU counters before returning;
/// nearby concurrent requests reuse the same measurement. No background timer
/// runs.
///
/// # Errors
/// Returns an error when system information cannot be read, the worker fails,
/// or a preceding panic poisoned the collector lock.
pub async fn system_status() -> Result<SystemStatus, SystemStatusError> {
    tokio::task::spawn_blocking(|| {
        let mut collector = COLLECTOR
            .lock()
            .map_err(|_| SystemStatusError::CollectorUnavailable)?;
        match collector.as_mut() {
            Some(collector) => collector.sample(),
            None => collector.insert(Collector::new()?).sample(),
        }
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearby_viewers_share_a_primed_measurement() {
        let mut collector = Collector::new().unwrap();
        let started = Instant::now();
        let first = collector.sample().unwrap();
        assert!(started.elapsed() >= MINIMUM_CPU_UPDATE_INTERVAL);
        assert_eq!(collector.sample().unwrap(), first);
    }

    #[test]
    fn resuming_after_a_pause_primes_a_fresh_cpu_window() {
        let mut collector = Collector::new().unwrap();
        let first = collector.sample().unwrap();
        collector.previous.as_mut().unwrap().0 -= MAX_CPU_SAMPLE_INTERVAL;
        let started = Instant::now();
        let resumed = collector.sample().unwrap();
        assert!(started.elapsed() >= MINIMUM_CPU_UPDATE_INTERVAL);
        assert!(resumed.sampled_at > first.sampled_at);
    }

    fn reading(percent: f64, full_energy: f64, state: BatteryState) -> BatteryReading {
        BatteryReading {
            percent,
            full_energy,
            state,
        }
    }

    #[test]
    fn no_batteries_report_no_battery_status() {
        assert_eq!(
            summarize_battery(std::iter::empty::<BatteryReading>()),
            None
        );
    }

    #[test]
    fn a_single_battery_reports_its_charge_and_direction() {
        let status = summarize_battery([reading(42.5, 50.0, BatteryState::Discharging)]).unwrap();
        assert_eq!(status.percent, 42.5);
        assert_eq!(status.state, BatteryState::Discharging);
    }

    #[test]
    fn several_batteries_weight_charge_by_full_capacity() {
        let status = summarize_battery([
            reading(90.0, 50.0, BatteryState::Discharging),
            reading(50.0, 25.0, BatteryState::Discharging),
        ])
        .unwrap();
        assert!((status.percent - 76.666_666_666_666_67).abs() < f64::EPSILON * 100.0);
    }

    #[test]
    fn charging_outranks_discharging_when_batteries_disagree() {
        let status = summarize_battery([
            reading(80.0, 50.0, BatteryState::Charging),
            reading(40.0, 50.0, BatteryState::Discharging),
        ])
        .unwrap();
        assert_eq!(status.state, BatteryState::Charging);
    }

    #[test]
    fn discharging_outranks_paused_when_batteries_disagree() {
        let status = summarize_battery([
            reading(80.0, 50.0, BatteryState::Paused),
            reading(40.0, 50.0, BatteryState::Discharging),
        ])
        .unwrap();
        assert_eq!(status.state, BatteryState::Discharging);
    }

    #[test]
    fn paused_outranks_empty_and_full_batteries() {
        let status = summarize_battery([
            reading(0.0, 50.0, BatteryState::Empty),
            reading(100.0, 50.0, BatteryState::Full),
            reading(80.0, 50.0, BatteryState::Paused),
        ])
        .unwrap();
        assert_eq!(status.state, BatteryState::Paused);
    }

    #[test]
    fn all_full_batteries_report_full() {
        let status = summarize_battery([
            reading(100.0, 50.0, BatteryState::Full),
            reading(100.0, 50.0, BatteryState::Full),
        ])
        .unwrap();
        assert_eq!(status.state, BatteryState::Full);
    }

    #[test]
    fn missing_capacity_falls_back_to_the_mean_charge() {
        let status = summarize_battery([
            reading(80.0, 0.0, BatteryState::Discharging),
            reading(20.0, 0.0, BatteryState::Discharging),
        ])
        .unwrap();
        assert_eq!(status.percent, 50.0);
    }

    #[test]
    fn charge_is_clamped_and_non_finite_readings_are_ignored() {
        let status = summarize_battery([
            reading(150.0, 0.0, BatteryState::Unknown),
            reading(f64::NAN, 100.0, BatteryState::Charging),
        ])
        .unwrap();
        assert_eq!(status.percent, 100.0);
        assert_eq!(status.state, BatteryState::Unknown);
        assert_eq!(
            summarize_battery([reading(f64::NAN, 50.0, BatteryState::Charging)]),
            None
        );
    }
}
