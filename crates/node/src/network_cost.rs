use napi_derive::napi;

/// Read the current connection's OS metered/low-data hint; false if unknown.
#[napi]
pub async fn is_network_metered() -> bool {
    deskfleet_native::network_cost::is_network_metered().await
}
