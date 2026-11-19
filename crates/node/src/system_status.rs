//! Thin conversion of the native machine sampler into JSON-compatible values.

use std::time::UNIX_EPOCH;

use napi::Result;
use napi_derive::napi;

use crate::rtc::native_error;

/// Power direction reported by a battery controller.
#[napi(string_enum = "lowercase")]
pub enum BatteryState {
    Unknown,
    Charging,
    Discharging,
    Empty,
    Full,
    Paused,
}

/// Aggregated battery charge and state for the machine.
#[napi(object)]
pub struct BatteryStatus {
    pub percent: f64,
    pub state: BatteryState,
}

/// Transient host metrics; byte counts and Unix milliseconds are JavaScript numbers.
#[napi(object)]
pub struct SystemStatus {
    pub sampled_at: f64,
    pub cpu_usage_percent: f64,
    pub memory_used_bytes: f64,
    pub memory_total_bytes: f64,
    pub swap_used_bytes: f64,
    pub swap_total_bytes: f64,
    pub cpu_model: String,
    pub logical_cpu_count: u32,
    pub os: String,
    pub arch: String,
    pub uptime_seconds: f64,
    pub battery: Option<BatteryStatus>,
}

/// Read the machine's CPU and memory usage without blocking Node's event loop.
#[napi]
pub async fn system_status() -> Result<SystemStatus> {
    let snapshot = deskfleet_native::system_status::system_status()
        .await
        .map_err(native_error)?;
    Ok(SystemStatus {
        sampled_at: snapshot
            .sampled_at
            .duration_since(UNIX_EPOCH)
            .map_err(native_error)?
            .as_millis() as f64,
        cpu_usage_percent: f64::from(snapshot.cpu_usage_percent),
        memory_used_bytes: snapshot.memory_used_bytes as f64,
        memory_total_bytes: snapshot.memory_total_bytes as f64,
        swap_used_bytes: snapshot.swap_used_bytes as f64,
        swap_total_bytes: snapshot.swap_total_bytes as f64,
        cpu_model: snapshot.cpu_model,
        logical_cpu_count: snapshot
            .logical_cpu_count
            .try_into()
            .map_err(native_error)?,
        os: snapshot.os,
        arch: snapshot.arch.to_owned(),
        uptime_seconds: snapshot.uptime_seconds as f64,
        battery: snapshot.battery.map(|battery| BatteryStatus {
            percent: battery.percent,
            state: match battery.state {
                deskfleet_native::system_status::BatteryState::Unknown => BatteryState::Unknown,
                deskfleet_native::system_status::BatteryState::Charging => BatteryState::Charging,
                deskfleet_native::system_status::BatteryState::Discharging => {
                    BatteryState::Discharging
                }
                deskfleet_native::system_status::BatteryState::Empty => BatteryState::Empty,
                deskfleet_native::system_status::BatteryState::Full => BatteryState::Full,
                deskfleet_native::system_status::BatteryState::Paused => BatteryState::Paused,
            },
        }),
    })
}
