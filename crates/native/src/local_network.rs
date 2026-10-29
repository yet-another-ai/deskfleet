//! Explicit local-network permission guidance for the desktop client process.

use std::io;

/// Outcome of trying to display macOS's local-network consent alert.
/// None of these outcomes reports the user's authorization decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalNetworkAccessRequest {
    /// Local-network operations were attempted; an alert is not guaranteed.
    Attempted,
    /// No broadcast-capable interface had an IPv6 link-local address.
    Unavailable,
    /// This platform does not require local-network consent.
    NotRequired,
}

#[derive(Debug, thiserror::Error)]
pub enum LocalNetworkError {
    #[error("local network permission worker failed: {0}")]
    Worker(#[from] tokio::task::JoinError),
    #[error("cannot enumerate local network interfaces: {0}")]
    Interfaces(#[source] io::Error),
    #[error("cannot create a socket for local network consent: {0}")]
    Socket(#[source] io::Error),
    #[error("cannot open Local Network settings: {0}")]
    OpenSettings(#[source] io::Error),
}

/// Attempt to trigger local-network consent in the calling desktop process.
///
/// Uses Apple's TN3179 approach: connect UDP sockets to randomized link-local
/// IPv6 destinations without sending packets. There is no public general
/// permission-check API, and a successful connection is not proof of a grant.
/// Invoke only after an explicit user action, never as a background check.
///
/// Returns `NotRequired` outside macOS or on macOS versions before 15.
///
/// # Errors
/// Returns an error if interface enumeration, socket creation, or the worker
/// fails. UDP connection errors are expected while consent is pending and do
/// not establish denial or grant.
pub async fn request_local_network_access() -> Result<LocalNetworkAccessRequest, LocalNetworkError>
{
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(request_macos).await?
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(LocalNetworkAccessRequest::NotRequired)
    }
}

/// Open the fixed macOS Local Network privacy pane; a no-op on other platforms.
///
/// # Errors
/// Returns an error if System Settings cannot be opened or the worker fails.
pub async fn open_local_network_settings() -> Result<(), LocalNetworkError> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(|| {
            crate::permission_settings::open("Privacy_LocalNetwork")
                .map_err(LocalNetworkError::OpenSettings)
        })
        .await??;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn request_macos() -> Result<LocalNetworkAccessRequest, LocalNetworkError> {
    use nix::net::if_::InterfaceFlags;
    use std::net::{Ipv6Addr, SocketAddrV6, UdpSocket};

    if predates_local_network_consent(sysinfo::System::os_version().as_deref()) {
        return Ok(LocalNetworkAccessRequest::NotRequired);
    }
    let interfaces =
        nix::ifaddrs::getifaddrs().map_err(|error| LocalNetworkError::Interfaces(error.into()))?;
    let host_parts = [rand::random(), rand::random()];
    let addresses = interfaces.filter_map(|interface| {
        let address = interface.address?.as_sockaddr_in6().copied()?;
        local_targets(
            interface.flags.contains(InterfaceFlags::IFF_BROADCAST),
            address.into(),
            host_parts,
        )
    });
    attempt_connections(
        addresses.flatten(),
        || UdpSocket::bind(SocketAddrV6::new(Ipv6Addr::UNSPECIFIED, 0, 0, 0)),
        // UDP connect sets a destination but sends no network traffic.
        |socket, address| socket.connect(address),
    )
}

#[cfg(any(target_os = "macos", test))]
fn predates_local_network_consent(version: Option<&str>) -> bool {
    version
        .and_then(|version| version.split('.').next()?.parse::<u32>().ok())
        .is_some_and(|major| major < 15)
}

#[cfg(any(target_os = "macos", test))]
fn local_targets(
    broadcast_capable: bool,
    address: std::net::SocketAddrV6,
    host_parts: [[u8; 8]; 2],
) -> Option<[std::net::SocketAddrV6; 2]> {
    if !broadcast_capable || !address.ip().is_unicast_link_local() {
        return None;
    }
    Some(host_parts.map(|host_part| {
        let mut octets = address.ip().octets();
        octets[8..].copy_from_slice(&host_part);
        std::net::SocketAddrV6::new(octets.into(), 9, address.flowinfo(), address.scope_id())
    }))
}

#[cfg(any(target_os = "macos", test))]
fn attempt_connections<S>(
    addresses: impl IntoIterator<Item = std::net::SocketAddrV6>,
    mut open: impl FnMut() -> io::Result<S>,
    mut connect: impl FnMut(S, std::net::SocketAddrV6) -> io::Result<()>,
) -> Result<LocalNetworkAccessRequest, LocalNetworkError> {
    let mut outcome = LocalNetworkAccessRequest::Unavailable;
    for address in addresses {
        let socket = open().map_err(LocalNetworkError::Socket)?;
        outcome = LocalNetworkAccessRequest::Attempted;
        if let Err(error) = connect(socket, address) {
            // macOS may reject the operation before the user answers its alert.
            tracing::debug!(%error, "local network consent trigger did not connect");
        }
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv6Addr, SocketAddrV6};

    use super::*;

    fn address(ip: &str) -> SocketAddrV6 {
        SocketAddrV6::new(ip.parse().expect("valid test IPv6 address"), 0, 0, 7)
    }

    #[test]
    fn only_link_local_addresses_on_broadcast_interfaces_are_selected() {
        let host_parts = [[1; 8], [2; 8]];
        assert!(local_targets(false, address("fe80::1234"), host_parts).is_none());
        for ip in ["::1", "::", "ff02::1", "2001:db8::1", "fd00::1"] {
            assert!(local_targets(true, address(ip), host_parts).is_none());
        }
    }

    #[test]
    fn targets_preserve_interface_scope_and_prefix_with_random_hosts_on_discard_port() {
        let source = SocketAddrV6::new(Ipv6Addr::new(0xfe80, 7, 0, 0, 0, 0, 0, 5), 80, 42, 7);
        let targets = local_targets(true, source, [[1; 8], [2; 8]])
            .expect("broadcast link-local address is eligible");

        for (target, host) in targets.into_iter().zip([1, 2]) {
            assert_eq!(&target.ip().octets()[..8], &source.ip().octets()[..8]);
            assert_eq!(&target.ip().octets()[8..], &[host; 8]);
            assert_eq!(target.port(), 9);
            assert_eq!(target.scope_id(), 7);
            assert_eq!(target.flowinfo(), 42);
        }
    }

    #[test]
    fn no_candidates_is_unavailable_without_opening_a_socket() {
        let result = attempt_connections(
            [],
            || -> io::Result<()> { panic!("no network operation is needed") },
            |(), _| panic!("no network operation is needed"),
        )
        .expect("no candidates is not a failure");
        assert_eq!(result, LocalNetworkAccessRequest::Unavailable);
    }

    #[test]
    fn connection_errors_do_not_stop_other_interfaces_or_claim_a_permission_decision() {
        let targets = [address("fe80::1"), address("fe80::2")];
        let mut seen = Vec::new();
        let result = attempt_connections(
            targets,
            || Ok(()),
            |(), target| {
                seen.push(target);
                Err(io::ErrorKind::PermissionDenied.into())
            },
        )
        .expect("a connection error can itself trigger consent");
        assert_eq!(seen, targets);
        assert_eq!(result, LocalNetworkAccessRequest::Attempted);
    }

    #[test]
    fn successful_udp_connect_only_reports_an_attempt() {
        assert_eq!(
            attempt_connections([address("fe80::1")], || Ok(()), |(), _| Ok(()))
                .expect("the operation was attempted"),
            LocalNetworkAccessRequest::Attempted,
        );
    }

    #[test]
    fn socket_setup_failures_preserve_their_cause_without_attempting_connect() {
        let error = attempt_connections(
            [address("fe80::1")],
            || Err::<(), _>(io::Error::other("socket unavailable")),
            |(), _| panic!("there is no socket to connect"),
        )
        .expect_err("socket setup failed");
        assert!(matches!(error, LocalNetworkError::Socket(source)
            if source.to_string() == "socket unavailable"));
    }

    #[test]
    fn only_known_older_macos_versions_skip_consent() {
        for version in [Some("13.6.9"), Some("14.7"), Some("10.15.7")] {
            assert!(predates_local_network_consent(version));
        }
        for version in [None, Some(""), Some("unknown"), Some("15.0"), Some("26.1")] {
            assert!(!predates_local_network_consent(version));
        }
    }
}
