#![allow(unsafe_code)] // A process-lifetime MTA keeps cached WinRT factories valid.

use std::sync::OnceLock;

use windows::Networking::Connectivity::{NetworkCostType, NetworkInformation};
use windows::Win32::System::Com::CoIncrementMTAUsage;

fn query() -> windows::core::Result<bool> {
    static MTA: OnceLock<windows::core::Result<()>> = OnceLock::new();
    MTA.get_or_init(|| {
        // windows-rs caches agile factories for the process lifetime. Releasing the
        // last apartment after a query can unload a factory still held by that cache.
        // Retain one MTA usage reference until process exit, including while all
        // blocking workers are idle; new workers join that MTA implicitly.
        // https://github.com/microsoft/windows-rs/issues/1169#issuecomment-2892318585
        // SAFETY: called from a normal worker, outside DllMain and process shutdown.
        // The cookie is intentionally not decremented: its lifetime matches the cache.
        unsafe { CoIncrementMTAUsage() }.map(|_| ())
    })
    .clone()?;
    let profile = NetworkInformation::GetInternetConnectionProfile()?;
    let cost = profile.GetConnectionCost()?;
    Ok(matches!(
        cost.NetworkCostType()?,
        NetworkCostType::Fixed | NetworkCostType::Variable
    ) || cost.Roaming()?
        || cost.OverDataLimit()?)
}

pub(super) fn is_metered() -> bool {
    match query() {
        Ok(metered) => metered,
        Err(error) => {
            // No Internet connection also produces a null-profile error.
            tracing::debug!(%error, "network cost is unavailable");
            false
        }
    }
}
