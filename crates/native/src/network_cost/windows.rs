#![allow(unsafe_code)] // The WinRT apartment is initialized and released on one worker.

use windows::Networking::Connectivity::{NetworkCostType, NetworkInformation};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};

struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: balances a successful RoInitialize on this same worker thread,
        // after every WinRT interface has been dropped.
        unsafe { RoUninitialize() };
    }
}

fn query() -> windows::core::Result<bool> {
    // SAFETY: all WinRT objects stay on this worker and drop before Apartment.
    unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
    let _apartment = Apartment;
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
