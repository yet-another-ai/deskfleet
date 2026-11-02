use std::{collections::VecDeque, sync::Mutex};

use rtc::stun::message::Setter;

use super::*;

fn address(value: &str) -> SocketAddrV4 {
    value.parse().expect("valid fixture address")
}

fn primary() -> SocketAddrV4 {
    address("192.0.2.1:3478")
}

fn other() -> SocketAddrV4 {
    address("192.0.2.2:3479")
}

fn local() -> SocketAddrV4 {
    address("10.0.0.1:50000")
}

fn mapped() -> SocketAddrV4 {
    address("198.51.100.1:60000")
}

fn response(mapped: SocketAddrV4) -> ProbeResult {
    ProbeResult::Response(Binding {
        mapped,
        other: Some(other()),
    })
}

struct Step {
    destination: SocketAddrV4,
    source: SocketAddrV4,
    change: u32,
    result: ProbeResult,
}

fn step(destination: SocketAddrV4, source: SocketAddrV4, change: u32, result: ProbeResult) -> Step {
    Step {
        destination,
        source,
        change,
        result,
    }
}

struct ScriptedProbe(Mutex<VecDeque<Step>>);

impl ScriptedProbe {
    fn new(steps: Vec<Step>) -> Self {
        Self(Mutex::new(steps.into()))
    }

    fn finished(&self) {
        assert!(self.0.lock().unwrap().is_empty());
    }
}

#[async_trait::async_trait]
impl Probe for ScriptedProbe {
    async fn request(
        &self,
        destination: SocketAddrV4,
        source: SocketAddrV4,
        change: u32,
    ) -> Result<ProbeResult, NatTestError> {
        let expected = self.0.lock().unwrap().pop_front().expect("expected probe");
        assert_eq!(destination, expected.destination);
        assert_eq!(source, expected.source);
        assert_eq!(change, expected.change);
        Ok(expected.result)
    }
}

#[tokio::test]
async fn discovers_mapping_and_filtering_without_opening_alternate_bindings_early() {
    for filtering in [
        NatFiltering::EndpointIndependent,
        NatFiltering::AddressDependent,
        NatFiltering::AddressAndPortDependent,
    ] {
        for mapping in [
            NatMapping::EndpointIndependent,
            NatMapping::AddressDependent,
            NatMapping::AddressAndPortDependent,
        ] {
            let mut steps = vec![step(primary(), primary(), 0, response(mapped()))];
            steps.push(step(
                primary(),
                other(),
                6,
                if filtering == NatFiltering::EndpointIndependent {
                    response(mapped())
                } else {
                    ProbeResult::NoResponse
                },
            ));
            if filtering != NatFiltering::EndpointIndependent {
                steps.push(step(
                    primary(),
                    address("192.0.2.1:3479"),
                    2,
                    if filtering == NatFiltering::AddressDependent {
                        response(mapped())
                    } else {
                        ProbeResult::NoResponse
                    },
                ));
            }
            if filtering == NatFiltering::AddressAndPortDependent {
                steps.push(step(primary(), primary(), 0, response(mapped())));
            }
            let next = if mapping == NatMapping::EndpointIndependent {
                mapped()
            } else {
                address("198.51.100.1:60001")
            };
            let alternate_ip = address("192.0.2.2:3478");
            steps.push(step(alternate_ip, alternate_ip, 0, response(next)));
            if mapping != NatMapping::EndpointIndependent {
                steps.push(step(
                    other(),
                    other(),
                    0,
                    response(if mapping == NatMapping::AddressDependent {
                        next
                    } else {
                        address("198.51.100.1:60002")
                    }),
                ));
            }
            let probe = ScriptedProbe::new(steps);
            let result = discover(&probe, primary(), local()).await.unwrap();
            assert_eq!(result.mapping, mapping);
            assert_eq!(result.filtering, filtering);
            assert_eq!(result.status, NatTestStatus::Complete);
            assert_eq!(result.public_address, Some(mapped()));
            probe.finished();
        }
    }
}

#[tokio::test]
async fn unchanged_local_endpoint_is_direct_even_with_filtering() {
    let probe = ScriptedProbe::new(vec![
        step(primary(), primary(), 0, response(local())),
        step(primary(), other(), 6, response(local())),
    ]);
    let result = discover(&probe, primary(), local()).await.unwrap();
    assert_eq!(result.mapping, NatMapping::Direct);
    assert_eq!(result.status, NatTestStatus::Complete);
    probe.finished();
}

#[tokio::test]
async fn ordinary_stun_or_invalid_other_address_preserves_public_endpoint() {
    for alternate in [
        None,
        Some(primary()),
        Some(address("192.0.2.1:3479")),
        Some(address("192.0.2.2:3478")),
        Some(address("192.0.2.2:0")),
    ] {
        let probe = ScriptedProbe::new(vec![step(
            primary(),
            primary(),
            0,
            ProbeResult::Response(Binding {
                mapped: mapped(),
                other: alternate,
            }),
        )]);
        let result = discover(&probe, primary(), local()).await.unwrap();
        assert_eq!(result.status, NatTestStatus::ServerUnsupported);
        assert_eq!(result.mapping, NatMapping::Unknown);
        assert_eq!(result.public_address, Some(mapped()));
        probe.finished();
    }
}

#[tokio::test]
async fn unreachable_server_does_not_claim_a_nat_type() {
    let probe = ScriptedProbe::new(vec![step(primary(), primary(), 0, ProbeResult::NoResponse)]);
    let result = discover(&probe, primary(), local()).await.unwrap();
    assert_eq!(result.status, NatTestStatus::UdpUnreachable);
    assert_eq!(result.public_address, None);
    assert_eq!(result.mapping, NatMapping::Unknown);
    probe.finished();
}

#[tokio::test]
async fn loss_of_original_route_cannot_be_classified_as_restrictive_filtering() {
    for last in [
        ProbeResult::NoResponse,
        response(address("198.51.100.2:60000")),
    ] {
        let probe = ScriptedProbe::new(vec![
            step(primary(), primary(), 0, response(mapped())),
            step(primary(), other(), 6, ProbeResult::NoResponse),
            step(
                primary(),
                address("192.0.2.1:3479"),
                2,
                ProbeResult::NoResponse,
            ),
            step(primary(), primary(), 0, last),
            step(
                address("192.0.2.2:3478"),
                address("192.0.2.2:3478"),
                0,
                response(mapped()),
            ),
        ]);
        let result = discover(&probe, primary(), local()).await.unwrap();
        assert_eq!(result.filtering, NatFiltering::Unknown);
        assert_eq!(result.status, NatTestStatus::Inconclusive);
        probe.finished();
    }
}

#[tokio::test]
async fn rejected_change_request_is_inconclusive_without_guessing_filtering() {
    let probe = ScriptedProbe::new(vec![
        step(primary(), primary(), 0, response(mapped())),
        step(primary(), other(), 6, ProbeResult::Unsupported),
        step(
            address("192.0.2.2:3478"),
            address("192.0.2.2:3478"),
            0,
            response(mapped()),
        ),
    ]);
    let result = discover(&probe, primary(), local()).await.unwrap();
    assert_eq!(result.filtering, NatFiltering::Unknown);
    assert_eq!(result.mapping, NatMapping::EndpointIndependent);
    assert_eq!(result.status, NatTestStatus::Inconclusive);
    probe.finished();
}

fn binding_message(transaction: TransactionId) -> Message {
    let mut message = Message::new();
    message
        .build(&[Box::new(transaction), Box::new(BINDING_SUCCESS)])
        .unwrap();
    XorMappedAddress {
        ip: (*mapped().ip()).into(),
        port: mapped().port(),
    }
    .add_to(&mut message)
    .unwrap();
    MappedAddress {
        ip: (*other().ip()).into(),
        port: other().port(),
    }
    .add_to_as(&mut message, ATTR_OTHER_ADDRESS)
    .unwrap();
    message
}

#[test]
fn accepts_only_the_matching_transaction_and_requested_source() {
    let transaction = TransactionId::new();
    let message = binding_message(transaction);
    assert!(matches!(
        read_response(
            &message.raw,
            other().into(),
            primary(),
            other(),
            transaction
        ),
        Some(ProbeResult::Response(_))
    ));
    assert!(matches!(
        read_response(
            &message.raw,
            primary().into(),
            primary(),
            other(),
            transaction
        ),
        Some(ProbeResult::Unsupported)
    ));
    assert!(
        read_response(
            &message.raw,
            other().into(),
            primary(),
            other(),
            TransactionId::new()
        )
        .is_none()
    );
    assert!(
        read_response(
            &message.raw,
            address("192.0.2.3:3479").into(),
            primary(),
            other(),
            transaction
        )
        .is_none()
    );
    assert!(
        read_response(
            &message.raw[..message.raw.len() - 1],
            other().into(),
            primary(),
            other(),
            transaction
        )
        .is_none()
    );
}

#[test]
fn validates_host_and_port_without_accepting_urls_or_ipv6() {
    assert_eq!(
        server_parts("stun.example.com:3478").unwrap(),
        ("stun.example.com", 3478)
    );
    assert_eq!(server_parts("192.0.2.1:3478").unwrap(), ("192.0.2.1", 3478));
    for value in [
        "",
        "stun.example.com",
        ":3478",
        "x:0",
        "x:65536",
        "x:word",
        "stun:example.com:3478",
        "[::1]:3478",
        "x /:3478",
    ] {
        assert!(server_parts(value).is_err(), "accepted {value}");
    }
}

#[tokio::test]
async fn closed_udp_port_is_unreachable_without_claiming_a_nat_type() {
    let server = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let SocketAddr::V4(server_address) = server.local_addr().unwrap() else {
        panic!("IPv4 fixture")
    };
    drop(server);
    let probe = UdpProbe {
        socket: UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap(),
        retry_delays: [Duration::from_millis(20); 3],
    };
    let SocketAddr::V4(local) = probe.socket.local_addr().unwrap() else {
        panic!("IPv4 fixture")
    };
    // Windows can report ICMP Port Unreachable here as ConnectionReset, while
    // other systems may silently drop these datagrams until the retries expire.
    let result = timeout(
        Duration::from_secs(2),
        discover(&probe, server_address, local),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result.status, NatTestStatus::UdpUnreachable);
    assert_eq!(result.public_address, None);
    assert_eq!(result.mapping, NatMapping::Unknown);
    assert_eq!(result.filtering, NatFiltering::Unknown);
}

#[tokio::test]
async fn udp_probe_retries_the_same_transaction_and_closes_after_response() {
    let server = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let SocketAddr::V4(server_address) = server.local_addr().unwrap() else {
        panic!("IPv4 fixture")
    };
    let responder = tokio::spawn(async move {
        let mut buffer = [0_u8; 512];
        let mut transaction = None;
        for attempt in 0..3 {
            let (length, source) = server.recv_from(&mut buffer).await.unwrap();
            let mut request = Message::new();
            request.unmarshal_binary(&buffer[..length]).unwrap();
            assert_eq!(request.typ, BINDING_REQUEST);
            if let Some(previous) = transaction {
                assert_eq!(request.transaction_id, previous);
            }
            transaction = Some(request.transaction_id);
            if attempt == 2 {
                server
                    .send_to(&binding_message(request.transaction_id).raw, source)
                    .await
                    .unwrap();
            }
        }
    });
    let probe = UdpProbe {
        socket: UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap(),
        retry_delays: [Duration::from_millis(20); 3],
    };
    let result = timeout(
        Duration::from_secs(2),
        probe.request(server_address, server_address, 0),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        matches!(result, ProbeResult::Response(Binding { mapped: value, .. }) if value == mapped())
    );
    responder.await.unwrap();
}
