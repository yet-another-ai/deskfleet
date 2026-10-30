//! On-demand machine CPU and memory sampling, independent of display access.

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
        };
        self.previous = Some((Instant::now(), snapshot.clone()));
        Ok(snapshot)
    }
}

/// Read host CPU and memory usage on a blocking worker, sharing one sampler
/// across viewers. The first read primes CPU counters before returning; nearby
/// concurrent requests reuse the same measurement. No background timer runs.
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
}
