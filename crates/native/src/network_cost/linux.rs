use zbus::{Connection, Proxy};

pub(super) async fn is_metered() -> zbus::Result<bool> {
    let connection = Connection::system().await?;
    let manager = Proxy::new(
        &connection,
        "org.freedesktop.NetworkManager",
        "/org/freedesktop/NetworkManager",
        "org.freedesktop.NetworkManager",
    )
    .await?;
    let metered: u32 = manager.get_property("Metered").await?;
    // NMMetered: YES=1 and GUESS_YES=3. This property follows the primary
    // connection, including the underlying transport when a VPN is active.
    Ok(matches!(metered, 1 | 3))
}
