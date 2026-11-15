//! Operating-system cost hints for the current Internet connection.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

/// Whether the current connection is marked metered, expensive, or low-data.
///
/// Unavailable platform services and unknown cost are treated as unmetered.
/// This is a local OS query; it does not send an Internet connectivity probe.
pub async fn is_network_metered() -> bool {
    #[cfg(target_os = "linux")]
    {
        match tokio::time::timeout(std::time::Duration::from_secs(2), linux::is_metered()).await {
            Ok(Ok(metered)) => metered,
            Ok(Err(error)) => {
                tracing::debug!(%error, "network cost is unavailable");
                false
            }
            Err(_) => {
                tracing::debug!("network cost query timed out");
                false
            }
        }
    }
    #[cfg(any(target_os = "macos", windows))]
    {
        #[cfg(target_os = "macos")]
        let query = macos::is_metered;
        #[cfg(windows)]
        let query = windows::is_metered;

        match tokio::task::spawn_blocking(query).await {
            Ok(metered) => metered,
            Err(error) => {
                tracing::debug!(%error, "network cost worker failed");
                false
            }
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        false
    }
}
