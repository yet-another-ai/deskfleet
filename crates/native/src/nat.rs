//! On-demand IPv4 NAT behavior discovery using RFC 5780 STUN probes.

use std::{
    io,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    time::{Duration, Instant},
};

use rtc::stun::{
    addr::MappedAddress,
    attributes::{ATTR_CHANGE_REQUEST, ATTR_OTHER_ADDRESS, ATTR_XORMAPPED_ADDRESS},
    message::{BINDING_ERROR, BINDING_REQUEST, BINDING_SUCCESS, Getter, Message, TransactionId},
    xoraddr::XorMappedAddress,
};
use tokio::{net::UdpSocket, time::timeout};

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NatMapping {
    Unknown,
    Direct,
    EndpointIndependent,
    AddressDependent,
    AddressAndPortDependent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NatFiltering {
    Unknown,
    EndpointIndependent,
    AddressDependent,
    AddressAndPortDependent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NatTestStatus {
    Complete,
    ServerUnsupported,
    Inconclusive,
    UdpUnreachable,
}

#[derive(Debug)]
pub struct NatTestResult {
    pub server: SocketAddrV4,
    pub local_address: SocketAddrV4,
    pub public_address: Option<SocketAddrV4>,
    pub mapping: NatMapping,
    pub filtering: NatFiltering,
    pub status: NatTestStatus,
    pub duration: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum NatTestError {
    #[error("STUN server must be an IPv4 address or hostname followed by a port (host:port)")]
    InvalidServer,
    #[error("STUN server has no IPv4 address")]
    NoIpv4Address,
    #[error("NAT test timed out")]
    TimedOut,
    #[error("NAT test network operation failed: {0}")]
    Network(#[from] io::Error),
    #[error("cannot construct STUN request: {0}")]
    Request(String),
}

/// Test this process's current IPv4 route to a user-selected STUN server.
///
/// The server must support RFC 5780 to identify mapping and filtering behavior.
/// Results describe these sockets at test time, not guaranteed peer connectivity.
///
/// # Errors
/// Returns an error for invalid input, name resolution or socket failures, or
/// when the complete operation exceeds 30 seconds. All probe sockets are scoped
/// to this future and close on completion or cancellation.
pub async fn test_nat(server: &str) -> Result<NatTestResult, NatTestError> {
    let started = Instant::now();
    let mut result = timeout(Duration::from_secs(30), test_nat_inner(server))
        .await
        .map_err(|_| NatTestError::TimedOut)??;
    result.duration = started.elapsed();
    Ok(result)
}

fn server_parts(server: &str) -> Result<(&str, u16), NatTestError> {
    let (host, port) = server.rsplit_once(':').ok_or(NatTestError::InvalidServer)?;
    let port = port
        .parse::<u16>()
        .map_err(|_| NatTestError::InvalidServer)?;
    if host.is_empty()
        || host.len() > 253
        || host
            .chars()
            .any(|c| !c.is_ascii_alphanumeric() && c != '.' && c != '-')
        || port == 0
    {
        return Err(NatTestError::InvalidServer);
    }
    Ok((host, port))
}

async fn test_nat_inner(server: &str) -> Result<NatTestResult, NatTestError> {
    let (host, port) = server_parts(server)?;
    let server = timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| NatTestError::TimedOut)??
    .find_map(|address| match address {
        SocketAddr::V4(address) => Some(address),
        SocketAddr::V6(_) => None,
    })
    .ok_or(NatTestError::NoIpv4Address)?;

    // A connected UDP socket discovers the selected interface without sending a
    // packet. The actual probe socket stays unconnected to receive changed-source
    // responses, and binds that interface so direct-address comparisons are real.
    let route = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
    route.connect(server).await?;
    let SocketAddr::V4(local) = route.local_addr()? else {
        return Err(NatTestError::NoIpv4Address);
    };
    let socket = UdpSocket::bind((*local.ip(), 0)).await?;
    drop(route);
    let SocketAddr::V4(local) = socket.local_addr()? else {
        return Err(NatTestError::NoIpv4Address);
    };
    discover(
        &UdpProbe {
            socket,
            retry_delays: [
                Duration::from_millis(500),
                Duration::from_secs(1),
                Duration::from_secs(2),
            ],
        },
        server,
        local,
    )
    .await
}

#[derive(Debug, Clone, Copy)]
struct Binding {
    mapped: SocketAddrV4,
    other: Option<SocketAddrV4>,
}

#[derive(Debug, Clone, Copy)]
enum ProbeResult {
    Response(Binding),
    NoResponse,
    Unsupported,
}

#[async_trait::async_trait]
trait Probe: Sync {
    async fn request(
        &self,
        destination: SocketAddrV4,
        source: SocketAddrV4,
        change: u32,
    ) -> Result<ProbeResult, NatTestError>;
}

struct UdpProbe {
    socket: UdpSocket,
    retry_delays: [Duration; 3],
}

#[async_trait::async_trait]
impl Probe for UdpProbe {
    async fn request(
        &self,
        destination: SocketAddrV4,
        source: SocketAddrV4,
        change: u32,
    ) -> Result<ProbeResult, NatTestError> {
        let mut request = Message::new();
        request
            .build(&[Box::new(TransactionId::new()), Box::new(BINDING_REQUEST)])
            .map_err(|error| NatTestError::Request(error.to_string()))?;
        if change != 0 {
            request.add(ATTR_CHANGE_REQUEST, &change.to_be_bytes());
        }
        let mut buffer = [0_u8; 2048];
        for delay in self.retry_delays {
            self.socket.send_to(&request.raw, destination).await?;
            let received = timeout(delay, async {
                loop {
                    let (length, sender) = self.socket.recv_from(&mut buffer).await?;
                    if let Some(response) = read_response(
                        &buffer[..length],
                        sender,
                        destination,
                        source,
                        request.transaction_id,
                    ) {
                        return Ok::<_, io::Error>(response);
                    }
                }
            })
            .await;
            match received {
                Ok(response) => return Ok(response?),
                Err(_) => continue,
            }
        }
        Ok(ProbeResult::NoResponse)
    }
}

fn read_response(
    raw: &[u8],
    sender: SocketAddr,
    destination: SocketAddrV4,
    expected_source: SocketAddrV4,
    transaction: TransactionId,
) -> Option<ProbeResult> {
    if raw.len() < 20 || raw.len() != 20 + usize::from(u16::from_be_bytes([raw[2], raw[3]])) {
        return None;
    }
    let mut message = Message::new();
    message.unmarshal_binary(raw).ok()?;
    if message.transaction_id != transaction {
        return None;
    }
    if sender == SocketAddr::V4(destination) && message.typ == BINDING_ERROR {
        return Some(ProbeResult::Unsupported);
    }
    if message.typ != BINDING_SUCCESS {
        return None;
    }
    if sender != SocketAddr::V4(expected_source) {
        // Some ordinary STUN servers silently ignore CHANGE-REQUEST. That is
        // evidence of an unsupported test, never of restrictive NAT filtering.
        return (sender == SocketAddr::V4(destination)).then_some(ProbeResult::Unsupported);
    }
    let attribute = message.get(ATTR_XORMAPPED_ADDRESS).ok()?;
    if attribute.len() != 8 || attribute[..2] != [0, 1] {
        return None;
    }
    let mut mapped = XorMappedAddress::default();
    mapped.get_from(&message).ok()?;
    let SocketAddr::V4(mapped) = SocketAddr::new(mapped.ip, mapped.port) else {
        return None;
    };
    let other = message.get(ATTR_OTHER_ADDRESS).ok().and_then(|attribute| {
        if attribute.len() != 8 || attribute[..2] != [0, 1] {
            return None;
        }
        let mut address = MappedAddress::default();
        address.get_from_as(&message, ATTR_OTHER_ADDRESS).ok()?;
        match SocketAddr::new(address.ip, address.port) {
            SocketAddr::V4(address) => Some(address),
            SocketAddr::V6(_) => None,
        }
    });
    Some(ProbeResult::Response(Binding { mapped, other }))
}

async fn discover(
    probe: &impl Probe,
    server: SocketAddrV4,
    local: SocketAddrV4,
) -> Result<NatTestResult, NatTestError> {
    let mut result = NatTestResult {
        server,
        local_address: local,
        public_address: None,
        mapping: NatMapping::Unknown,
        filtering: NatFiltering::Unknown,
        status: NatTestStatus::UdpUnreachable,
        duration: Duration::ZERO,
    };
    let initial = match probe.request(server, server, 0).await? {
        ProbeResult::Response(binding) => binding,
        ProbeResult::Unsupported => {
            result.status = NatTestStatus::ServerUnsupported;
            return Ok(result);
        }
        ProbeResult::NoResponse => return Ok(result),
    };
    result.public_address = Some(initial.mapped);
    if initial.mapped == local {
        result.mapping = NatMapping::Direct;
    }
    let Some(other) = initial.other.filter(|other| {
        other.ip() != server.ip() && other.port() != server.port() && other.port() != 0
    }) else {
        result.status = NatTestStatus::ServerUnsupported;
        return Ok(result);
    };

    // Filtering must precede mapping: sending to alternate addresses first
    // would create firewall permissions and invalidate the filtering test.
    result.filtering = match probe.request(server, other, 0x06).await? {
        ProbeResult::Response(binding) if binding.mapped == initial.mapped => {
            NatFiltering::EndpointIndependent
        }
        ProbeResult::Response(_) => NatFiltering::Unknown,
        ProbeResult::Unsupported => NatFiltering::Unknown,
        ProbeResult::NoResponse => {
            let changed_port = SocketAddrV4::new(*server.ip(), other.port());
            match probe.request(server, changed_port, 0x02).await? {
                ProbeResult::Response(binding) if binding.mapped == initial.mapped => {
                    NatFiltering::AddressDependent
                }
                ProbeResult::Response(_) => NatFiltering::Unknown,
                ProbeResult::Unsupported => NatFiltering::Unknown,
                ProbeResult::NoResponse => {
                    // Verify the original route still responds before interpreting
                    // two timeouts as address-and-port-dependent filtering.
                    match probe.request(server, server, 0).await? {
                        ProbeResult::Response(binding) if binding.mapped == initial.mapped => {
                            NatFiltering::AddressAndPortDependent
                        }
                        _ => NatFiltering::Unknown,
                    }
                }
            }
        }
    };
    if result.mapping != NatMapping::Direct {
        let alternate_ip = SocketAddrV4::new(*other.ip(), server.port());
        result.mapping = match probe.request(alternate_ip, alternate_ip, 0).await? {
            ProbeResult::Response(binding) if binding.mapped == initial.mapped => {
                NatMapping::EndpointIndependent
            }
            ProbeResult::Response(binding) => match probe.request(other, other, 0).await? {
                ProbeResult::Response(last) if last.mapped == binding.mapped => {
                    NatMapping::AddressDependent
                }
                ProbeResult::Response(_) => NatMapping::AddressAndPortDependent,
                _ => NatMapping::Unknown,
            },
            _ => NatMapping::Unknown,
        };
    }
    result.status =
        if result.mapping == NatMapping::Unknown || result.filtering == NatFiltering::Unknown {
            NatTestStatus::Inconclusive
        } else {
            NatTestStatus::Complete
        };
    Ok(result)
}
