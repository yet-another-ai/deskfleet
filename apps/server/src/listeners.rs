//! Bind the complete HTTP listener set before starting the application.
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    io,
    net::{SocketAddr, TcpListener},
};

pub(super) fn bind_all(addresses: &[SocketAddr]) -> io::Result<Vec<TcpListener>> {
    addresses
        .iter()
        .map(|&address| {
            // A dual-stack wildcard would otherwise claim the IPv4 port too.
            // Inspect the entire list so either address order works.
            let ipv6_only = address.is_ipv6()
                && address.ip().is_unspecified()
                && addresses
                    .iter()
                    .any(|other| other.is_ipv4() && other.port() == address.port());
            bind(address, ipv6_only).map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!("failed to listen on {address}: {error}"),
                )
            })
        })
        .collect()
}

fn bind(address: SocketAddr, ipv6_only: bool) -> io::Result<TcpListener> {
    let socket = Socket::new(
        Domain::for_address(address),
        Type::STREAM,
        Some(Protocol::TCP),
    )?;
    // Match Actix's listener options, including its single-address behavior.
    #[cfg(not(windows))]
    socket.set_reuse_address(true)?;
    if ipv6_only {
        socket.set_only_v6(true)?;
    }
    #[cfg(windows)]
    if address.is_ipv6()
        && !ipv6_only
        && let Err(error) = socket.set_only_v6(false)
    {
        tracing::warn!(%address, %error, "failed to enable IPv4-mapped IPv6 connections");
    }
    socket.bind(&address.into())?;
    socket.listen(1024)?;
    Ok(socket.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{App, HttpServer};
    use deskfleet_protocol::HealthResponse;
    use std::{
        net::{Ipv4Addr, Ipv6Addr},
        time::Duration,
    };

    #[actix_web::test]
    async fn serves_health_on_single_addresses_and_multiple_ports() {
        for addresses in [
            vec!["127.0.0.1:0"],
            vec!["[::1]:0"],
            vec!["127.0.0.1:0", "127.0.0.1:0"],
        ] {
            let addresses: Vec<_> = addresses.iter().map(|addr| addr.parse().unwrap()).collect();
            let listeners = bind_all(&addresses).unwrap();
            assert_eq!(listeners.len(), addresses.len());
            assert_health_on_each(listeners).await;
        }
    }

    #[actix_web::test]
    async fn serves_ipv4_and_ipv6_on_the_same_port_in_either_order() {
        for ipv6_first in [false, true] {
            let port = unused_ipv4_address().port();
            let mut addresses = vec![
                SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)),
                SocketAddr::from((Ipv6Addr::UNSPECIFIED, port)),
            ];
            if ipv6_first {
                addresses.reverse();
            }
            let listeners = bind_all(&addresses).unwrap();
            assert_eq!(listeners.len(), 2);
            for listener in &listeners {
                let address = listener.local_addr().unwrap();
                assert_eq!(address.port(), port);
                if address.is_ipv6() {
                    assert!(socket2::SockRef::from(listener).only_v6().unwrap());
                }
            }
            assert_health_on_each(listeners).await;
        }
    }

    #[test]
    fn failed_bind_reports_address_and_releases_earlier_listeners() {
        let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
        let unavailable = occupied.local_addr().unwrap();
        let first = unused_ipv4_address();
        let error = bind_all(&[first, unavailable]).unwrap_err();
        assert!(error.to_string().contains(&unavailable.to_string()));
        let _rebound = TcpListener::bind(first).unwrap();
    }

    fn unused_ipv4_address() -> SocketAddr {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
    }

    async fn assert_health_on_each(listeners: Vec<TcpListener>) {
        let mut server = HttpServer::new(|| App::new().configure(deskfleet_server::configure))
            .workers(1)
            .disable_signals();
        let mut addresses = Vec::new();
        for listener in listeners {
            let mut address = listener.local_addr().unwrap();
            if address.ip().is_unspecified() {
                address.set_ip(if address.is_ipv4() {
                    Ipv4Addr::LOCALHOST.into()
                } else {
                    Ipv6Addr::LOCALHOST.into()
                });
            }
            addresses.push(address);
            server = server.listen(listener).unwrap();
        }
        let server = server.run();
        let handle = server.handle();
        let task = actix_web::rt::spawn(server);
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let mut responses = Vec::new();
        for address in addresses {
            responses.push(
                async {
                    client
                        .get(format!("http://{address}/healthz"))
                        .send()
                        .await?
                        .error_for_status()?
                        .json::<serde_json::Value>()
                        .await
                }
                .await,
            );
        }
        handle.stop(false).await;
        task.await.unwrap().unwrap();
        for response in responses {
            assert_eq!(
                response.unwrap(),
                serde_json::to_value(HealthResponse::ok(env!("CARGO_PKG_VERSION"))).unwrap()
            );
        }
    }
}
