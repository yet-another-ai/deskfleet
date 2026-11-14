//! RFC 5780 STUN NAT discovery + macOS Local Network privacy helpers.

use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::{Duration, Instant};

use rtc::stun::{
    addr::MappedAddress,
    attributes::{ATTR_CHANGE_REQUEST, ATTR_OTHER_ADDRESS, ATTR_XORMAPPED_ADDRESS},
    message::{BINDING_ERROR, BINDING_REQUEST, BINDING_SUCCESS, Getter, Message, TransactionId},
    xoraddr::XorMappedAddress,
};
use serde::Serialize;
use tokio::net::UdpSocket;
use tokio::time::{sleep, timeout};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NatResultDto {
    pub server: String,
    pub local_address: String,
    pub public_address: Option<String>,
    pub mapping: &'static str,
    pub filtering: &'static str,
    pub status: &'static str,
    pub duration_ms: u64,
}

#[derive(Clone, Copy)]
struct Binding {
    mapped: SocketAddrV4,
    other: Option<SocketAddrV4>,
}

#[derive(Clone, Copy)]
enum ProbeOutcome {
    Response(Binding),
    NoResponse,
    Unsupported,
}

fn is_port_unreachable(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionRefused
    )
}

fn read_response(
    raw: &[u8],
    sender: SocketAddr,
    destination: SocketAddrV4,
    expected_source: SocketAddrV4,
    transaction: TransactionId,
) -> Option<ProbeOutcome> {
    if raw.len() < 20 || raw.len() != 20 + usize::from(u16::from_be_bytes([raw[2], raw[3]])) {
        return None;
    }
    let mut message = Message::new();
    message.unmarshal_binary(raw).ok()?;
    if message.transaction_id != transaction {
        return None;
    }
    if sender == SocketAddr::V4(destination) && message.typ == BINDING_ERROR {
        return Some(ProbeOutcome::Unsupported);
    }
    if message.typ != BINDING_SUCCESS {
        return None;
    }
    if sender != SocketAddr::V4(expected_source) {
        return (sender == SocketAddr::V4(destination)).then_some(ProbeOutcome::Unsupported);
    }
    let attr = message.get(ATTR_XORMAPPED_ADDRESS).ok()?;
    if attr.len() != 8 || attr[..2] != [0, 1] {
        return None;
    }
    let mut mapped = XorMappedAddress::default();
    mapped.get_from(&message).ok()?;
    let SocketAddr::V4(mapped) = SocketAddr::new(mapped.ip, mapped.port) else {
        return None;
    };
    let other = message.get(ATTR_OTHER_ADDRESS).ok().and_then(|a| {
        if a.len() != 8 || a[..2] != [0, 1] {
            return None;
        }
        let mut addr = MappedAddress::default();
        addr.get_from_as(&message, ATTR_OTHER_ADDRESS).ok()?;
        match SocketAddr::new(addr.ip, addr.port) {
            SocketAddr::V4(v4) => Some(v4),
            SocketAddr::V6(_) => None,
        }
    });
    Some(ProbeOutcome::Response(Binding { mapped, other }))
}

async fn stun_request(
    socket: &UdpSocket,
    destination: SocketAddrV4,
    expected_source: SocketAddrV4,
    change: u32,
) -> Result<ProbeOutcome, String> {
    let mut req = Message::new();
    req.build(&[Box::new(TransactionId::new()), Box::new(BINDING_REQUEST)])
        .map_err(|e| e.to_string())?;
    if change != 0 {
        req.add(ATTR_CHANGE_REQUEST, &change.to_be_bytes());
    }
    let mut buf = [0_u8; 2048];
    for delay in [
        Duration::from_millis(500),
        Duration::from_secs(1),
        Duration::from_secs(2),
    ] {
        if let Err(err) = socket.send_to(&req.raw, destination).await {
            if !is_port_unreachable(&err) {
                return Err(err.to_string());
            }
            sleep(delay).await;
            continue;
        }
        let recv_res = timeout(delay, async {
            loop {
                let (len, sender) = match socket.recv_from(&mut buf).await {
                    Ok(pair) => pair,
                    Err(e) if is_port_unreachable(&e) => continue,
                    Err(e) => return Err(e),
                };
                if let Some(outcome) = read_response(
                    &buf[..len],
                    sender,
                    destination,
                    expected_source,
                    req.transaction_id,
                ) {
                    return Ok(outcome);
                }
            }
        })
        .await;
        if let Ok(outcome) = recv_res {
            return outcome.map_err(|e| e.to_string());
        }
    }
    Ok(ProbeOutcome::NoResponse)
}

pub async fn probe_nat(server_str: &str) -> Result<NatResultDto, String> {
    let started = Instant::now();
    let (host, port_str) = server_str
        .rsplit_once(':')
        .ok_or_else(|| "STUN server must be host:port".to_owned())?;
    let port: u16 = port_str
        .parse()
        .map_err(|_| "invalid STUN port".to_owned())?;
    if host.is_empty() || port == 0 {
        return Err("invalid STUN server".to_owned());
    }
    let server = timeout(Duration::from_secs(5), tokio::net::lookup_host((host, port)))
        .await
        .map_err(|_| "STUN lookup timed out".to_owned())?
        .map_err(|e| e.to_string())?
        .find_map(|addr| match addr {
            SocketAddr::V4(v4) => Some(v4),
            SocketAddr::V6(_) => None,
        })
        .ok_or_else(|| "STUN server has no IPv4 address".to_owned())?;

    let route = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .await
        .map_err(|e| e.to_string())?;
    route.connect(server).await.map_err(|e| e.to_string())?;
    let SocketAddr::V4(route_local) = route.local_addr().map_err(|e| e.to_string())? else {
        return Err("no IPv4 local address".to_owned());
    };
    let socket = UdpSocket::bind((*route_local.ip(), 0))
        .await
        .map_err(|e| e.to_string())?;
    drop(route);
    let SocketAddr::V4(local) = socket.local_addr().map_err(|e| e.to_string())? else {
        return Err("no IPv4 local address".to_owned());
    };

    let mut dto = NatResultDto {
        server: server.to_string(),
        local_address: local.to_string(),
        public_address: None,
        mapping: "unknown",
        filtering: "unknown",
        status: "udp-unreachable",
        duration_ms: 0,
    };

    let initial = match stun_request(&socket, server, server, 0).await? {
        ProbeOutcome::Response(b) => b,
        ProbeOutcome::Unsupported => {
            dto.status = "server-unsupported";
            dto.duration_ms = started.elapsed().as_millis() as u64;
            return Ok(dto);
        }
        ProbeOutcome::NoResponse => {
            dto.duration_ms = started.elapsed().as_millis() as u64;
            return Ok(dto);
        }
    };
    dto.public_address = Some(initial.mapped.to_string());
    if initial.mapped == local {
        dto.mapping = "direct";
    }
    let Some(other) = initial.other.filter(|o| {
        o.ip() != server.ip() && o.port() != server.port() && o.port() != 0
    }) else {
        dto.status = "server-unsupported";
        dto.duration_ms = started.elapsed().as_millis() as u64;
        return Ok(dto);
    };

    dto.filtering = match stun_request(&socket, server, other, 0x06).await? {
        ProbeOutcome::Response(b) if b.mapped == initial.mapped => "endpoint-independent",
        ProbeOutcome::NoResponse => {
            let changed_port = SocketAddrV4::new(*server.ip(), other.port());
            match stun_request(&socket, server, changed_port, 0x02).await? {
                ProbeOutcome::Response(b) if b.mapped == initial.mapped => "address-dependent",
                ProbeOutcome::NoResponse => match stun_request(&socket, server, server, 0).await? {
                    ProbeOutcome::Response(b) if b.mapped == initial.mapped => {
                        "address-and-port-dependent"
                    }
                    _ => "unknown",
                },
                _ => "unknown",
            }
        }
        _ => "unknown",
    };

    if dto.mapping != "direct" {
        let alt_ip = SocketAddrV4::new(*other.ip(), server.port());
        dto.mapping = match stun_request(&socket, alt_ip, alt_ip, 0).await? {
            ProbeOutcome::Response(b) if b.mapped == initial.mapped => "endpoint-independent",
            ProbeOutcome::Response(b) => match stun_request(&socket, other, other, 0).await? {
                ProbeOutcome::Response(last) if last.mapped == b.mapped => "address-dependent",
                ProbeOutcome::Response(_) => "address-and-port-dependent",
                _ => "unknown",
            },
            _ => "unknown",
        };
    }

    dto.status = if dto.mapping == "unknown" || dto.filtering == "unknown" {
        "inconclusive"
    } else {
        "complete"
    };
    dto.duration_ms = started.elapsed().as_millis() as u64;
    Ok(dto)
}

pub fn trigger_local_network_consent() -> Result<&'static str, String> {
    #[cfg(target_os = "macos")]
    {
        use nix::net::if_::InterfaceFlags;
        use std::net::{Ipv6Addr, SocketAddrV6};
        let interfaces = nix::ifaddrs::getifaddrs().map_err(|e| e.to_string())?;
        let host_parts: [[u8; 8]; 2] = [rand::random(), rand::random()];
        let mut outcome = "unavailable";
        for iface in interfaces {
            if !iface.flags.contains(InterfaceFlags::IFF_BROADCAST) {
                continue;
            }
            let Some(sockaddr) = iface.address.and_then(|a| a.as_sockaddr_in6().copied()) else {
                continue;
            };
            let v6: SocketAddrV6 = sockaddr.into();
            if !v6.ip().is_unicast_link_local() {
                continue;
            }
            for part in host_parts {
                let mut octets = v6.ip().octets();
                octets[8..].copy_from_slice(&part);
                let target = SocketAddrV6::new(octets.into(), 9, v6.flowinfo(), v6.scope_id());
                let sock = std::net::UdpSocket::bind(SocketAddrV6::new(
                    Ipv6Addr::UNSPECIFIED,
                    0,
                    0,
                    0,
                ))
                .map_err(|e| e.to_string())?;
                outcome = "attempted";
                let _ = sock.connect(target);
            }
        }
        Ok(outcome)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("not-required")
    }
}

pub fn open_macos_local_network_pane() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork")
            .status()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
