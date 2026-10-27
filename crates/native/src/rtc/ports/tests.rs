use super::*;
use crate::rtc::{Peer, PeerConfig};
use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpSocket;

fn expires_after(duration: Duration) -> u64 {
    u64::try_from((SystemTime::now().duration_since(UNIX_EPOCH).unwrap() + duration).as_millis())
        .unwrap()
}

async fn connect(left: &Peer, right: &Peer) {
    let offer = left.create_offer().await.unwrap();
    let answer = right.answer_offer(offer).await.unwrap();
    left.accept_answer(answer).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut left_open = false;
        let mut right_open = false;
        while !left_open || !right_open {
            tokio::select! {
                event = left.next_event() => match event.unwrap().unwrap() {
                    PeerEvent::IceCandidate(Some(candidate)) => right.add_ice_candidate(candidate).await.unwrap(),
                    PeerEvent::DataChannelOpen { label } => { assert_eq!(label, CHANNEL); left_open = true; }
                    PeerEvent::Error { message, .. } => panic!("left peer: {message}"),
                    _ => {},
                },
                event = right.next_event() => match event.unwrap().unwrap() {
                    PeerEvent::IceCandidate(Some(candidate)) => left.add_ice_candidate(candidate).await.unwrap(),
                    PeerEvent::DataChannelOpen { label } => { assert_eq!(label, CHANNEL); right_open = true; }
                    PeerEvent::Error { message, .. } => panic!("right peer: {message}"),
                    _ => {},
                },
            }
        }
    }).await.expect("local peers should connect");
}

async fn pair(port: u16) -> (Peer, Peer, u16) {
    let left = Peer::new(PeerConfig::default()).await.unwrap();
    let right = Peer::new(PeerConfig::default()).await.unwrap();
    right
        .enable_port_forwarding(expires_after(Duration::from_secs(120)))
        .await
        .unwrap();
    let local = left
        .listen_port_forward(0, "127.0.0.1", port)
        .await
        .unwrap();
    connect(&left, &right).await;
    (left, right, local)
}

#[tokio::test]
async fn concurrent_binary_streams_preserve_half_close_without_event_consumers() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let (left, right, local) = pair(listener.local_addr().unwrap().port()).await;
    // Each request is larger than the old event queue and several credit windows.
    // Stop consuming PeerEvents entirely during the transfer.
    let services = tokio::spawn(async move {
        let mut requests = tokio::task::JoinSet::new();
        for _ in 0..4 {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.spawn(async move {
                let mut request = Vec::new();
                socket.read_to_end(&mut request).await.unwrap();
                // A response after request EOF must survive TCP half-close.
                request.reverse();
                socket.write_all(&request).await.unwrap();
                socket.shutdown().await.unwrap();
            });
        }
        while let Some(value) = requests.join_next().await {
            value.unwrap();
        }
    });
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut clients = tokio::task::JoinSet::new();
        for index in 0..4u8 {
            clients.spawn(async move {
                let mut socket = TcpStream::connect((Ipv4Addr::LOCALHOST, local))
                    .await
                    .unwrap();
                let mut payload: Vec<_> = (0..2_000_000)
                    .map(|value| (value % 251) as u8 ^ index)
                    .collect();
                socket.write_all(&payload).await.unwrap();
                socket.shutdown().await.unwrap();
                let mut response = Vec::new();
                socket.read_to_end(&mut response).await.unwrap();
                payload.reverse();
                assert_eq!(response, payload);
            });
        }
        while let Some(value) = clients.join_next().await {
            value.unwrap();
        }
        services.await.unwrap();
    })
    .await
    .expect("concurrent transfers should finish");
    left.close().await.unwrap();
    right.close().await.unwrap();
    for peer in [&left, &right] {
        while let Some(event) = peer.next_event().await.unwrap() {
            assert!(
                !matches!(event, PeerEvent::Data { .. }),
                "payload must remain native"
            );
            if let PeerEvent::Error { message, .. } = event {
                panic!("peer failed: {message}");
            }
        }
    }
}

#[tokio::test]
async fn full_duplex_large_streams_and_slow_receivers_apply_backpressure() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let (left, right, local) = pair(listener.local_addr().unwrap().port()).await;
    let service = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let (mut read, mut write) = socket.into_split();
        let outgoing = async {
            write.write_all(&vec![0x5a; 3_000_000]).await.unwrap();
            write.shutdown().await.unwrap();
        };
        let incoming = async {
            // Exercise a socket consumer which drains more slowly than WebRTC.
            tokio::time::sleep(Duration::from_millis(100)).await;
            let mut bytes = Vec::new();
            read.read_to_end(&mut bytes).await.unwrap();
            assert_eq!(bytes, vec![0xa5; 3_000_000]);
        };
        tokio::join!(outgoing, incoming);
    });
    tokio::time::timeout(Duration::from_secs(30), async {
        let socket = TcpStream::connect((Ipv4Addr::LOCALHOST, local))
            .await
            .unwrap();
        let (mut read, mut write) = socket.into_split();
        let outgoing = async {
            write.write_all(&vec![0xa5; 3_000_000]).await.unwrap();
            write.shutdown().await.unwrap();
        };
        let incoming = async {
            let mut bytes = Vec::new();
            read.read_to_end(&mut bytes).await.unwrap();
            assert_eq!(bytes, vec![0x5a; 3_000_000]);
        };
        tokio::join!(outgoing, incoming);
        service.await.unwrap();
    })
    .await
    .expect("full duplex forwarding should finish");
    left.close().await.unwrap();
    right.close().await.unwrap();
}

#[tokio::test]
async fn saturated_concurrent_duplex_streams_keep_receiving_while_sending() {
    const CONNECTIONS: usize = MAX_CONNECTIONS;
    const BYTES: usize = 2 * 1024 * 1024;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let (left, right, local) = pair(listener.local_addr().unwrap().port()).await;
    // Every connection begins writing together: aggregate in-flight credits
    // exceed the DataChannel send budget in both directions.
    let ready = Arc::new(tokio::sync::Barrier::new(CONNECTIONS * 2 + 1));
    let service_ready = Arc::clone(&ready);
    let service = tokio::spawn(async move {
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..CONNECTIONS {
            let (socket, _) = listener.accept().await.unwrap();
            let ready = Arc::clone(&service_ready);
            tasks.spawn(async move {
                ready.wait().await;
                duplex(socket, BYTES, 0xa5, 0x5a).await;
            });
        }
        while let Some(value) = tasks.join_next().await {
            value.unwrap();
        }
    });
    tokio::time::timeout(Duration::from_secs(40), async {
        let mut clients = tokio::task::JoinSet::new();
        for _ in 0..CONNECTIONS {
            let ready = Arc::clone(&ready);
            clients.spawn(async move {
                let socket = TcpStream::connect((Ipv4Addr::LOCALHOST, local))
                    .await
                    .unwrap();
                ready.wait().await;
                duplex(socket, BYTES, 0x5a, 0xa5).await;
            });
        }
        ready.wait().await;
        while let Some(value) = clients.join_next().await {
            value.unwrap();
        }
        service.await.unwrap();
    })
    .await
    .expect("saturated peers must make progress in both directions");
    left.close().await.unwrap();
    right.close().await.unwrap();
}

async fn duplex(socket: TcpStream, count: usize, outgoing: u8, expected: u8) {
    let (mut read, mut write) = socket.into_split();
    let outgoing = async {
        write.write_all(&vec![outgoing; count]).await.unwrap();
        write.shutdown().await.unwrap();
    };
    let incoming = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut bytes = Vec::new();
        read.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes.len(), count);
        assert!(bytes.iter().all(|&byte| byte == expected));
    };
    tokio::join!(outgoing, incoming);
}

#[tokio::test]
async fn refused_connection_does_not_close_the_listener_or_peer() {
    let bind = |port| {
        let socket = TcpSocket::new_v4().unwrap();
        socket.set_reuseaddr(true).unwrap();
        socket.bind((Ipv4Addr::LOCALHOST, port).into()).unwrap();
        socket.listen(1).unwrap()
    };
    let reserve = bind(0);
    let target = reserve.local_addr().unwrap().port();
    let _reserved_client = TcpStream::connect((Ipv4Addr::LOCALHOST, target))
        .await
        .unwrap();
    let (_reserved_server, _) = reserve.accept().await.unwrap();
    // The established connection reserves this port while the closed listener
    // refuses new connections. Address reuse lets the service reopen it later.
    drop(reserve);
    let (left, right, local) = pair(target).await;
    let mut refused = TcpStream::connect((Ipv4Addr::LOCALHOST, local))
        .await
        .unwrap();
    let mut byte = [0];
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), refused.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    let listener = bind(target);
    let service = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        socket.write_all(b"ready").await.unwrap();
    });
    let mut socket = TcpStream::connect((Ipv4Addr::LOCALHOST, local))
        .await
        .unwrap();
    let mut result = [0; 5];
    tokio::time::timeout(Duration::from_secs(5), socket.read_exact(&mut result))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&result, b"ready");
    service.await.unwrap();
    left.close().await.unwrap();
    right.close().await.unwrap();
}

#[tokio::test]
async fn closing_peer_closes_listener_and_both_socket_halves() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let (left, right, local) = pair(listener.local_addr().unwrap().port()).await;
    let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, local))
        .await
        .unwrap();
    let (mut target, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    left.close().await.unwrap();
    right.close().await.unwrap();
    assert!(
        TcpStream::connect((Ipv4Addr::LOCALHOST, local))
            .await
            .is_err()
    );
    let mut byte = [0];
    assert_eq!(client.read(&mut byte).await.unwrap(), 0);
    assert_eq!(target.read(&mut byte).await.unwrap(), 0);
}

#[tokio::test]
async fn native_deadline_closes_idle_sockets_without_js_or_event_consumers() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let left = Peer::new(PeerConfig::default()).await.unwrap();
    let right = Peer::new(PeerConfig::default()).await.unwrap();
    right
        .enable_port_forwarding(expires_after(Duration::from_secs(3)))
        .await
        .unwrap();
    let local = left
        .listen_port_forward(0, "127.0.0.1", listener.local_addr().unwrap().port())
        .await
        .unwrap();
    connect(&left, &right).await;
    let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, local))
        .await
        .unwrap();
    let (mut target, _) = listener.accept().await.unwrap();
    let mut byte = [0];
    tokio::time::timeout(Duration::from_secs(5), async {
        assert_eq!(target.read(&mut byte).await.unwrap(), 0);
        assert_eq!(client.read(&mut byte).await.unwrap(), 0);
    })
    .await
    .expect("native expiry must close sockets");
    left.close().await.unwrap();
    right.close().await.unwrap();
}

#[tokio::test]
async fn forwarding_requires_explicit_authorization_and_loopback_target() {
    let peer = Peer::new(PeerConfig::default()).await.unwrap();
    for host in [
        "localhost",
        "127.0.0.2",
        "::ffff:127.0.0.1",
        "192.168.1.1",
        "example.com",
    ] {
        assert!(peer.listen_port_forward(0, host, 80).await.is_err());
    }
    assert!(peer.listen_port_forward(0, "127.0.0.1", 0).await.is_err());
    assert!(peer.enable_port_forwarding(1).await.is_err());
    assert!(peer.create_data_channel(CHANNEL.to_owned()).await.is_err());
    let channel = peer.pc.create_data_channel(CHANNEL, None).await.unwrap();
    assert!(
        peer.ports
            .attach(channel.clone(), peer.events.clone())
            .await
            .is_err()
    );
    channel.close().await.unwrap();
    peer.close().await.unwrap();
}

#[test]
fn wire_rejects_invalid_targets_frames_and_zero_ids() {
    for value in [
        vec![1, 0, 0, 0, 1, 4, 0, 0],
        vec![1, 0, 0, 0, 1, 8, 0, 80],
        vec![1, 0, 0, 0, 0, 4, 0, 80],
        vec![3, 0, 0, 0, 1],
        vec![7, 0, 0, 0, 1],
    ] {
        assert!(Frame::decode(Bytes::from(value), false).is_err());
    }
    assert!(Frame::decode(Bytes::from(vec![0; CHUNK_BYTES + 6]), false).is_err());
    assert!(Frame::decode(Bytes::from_static(&[5, 0, 0, 0, 1]), true).is_err());
    for host in ["127.0.0.1", "::1"] {
        let target = Target::new(host, 65535).unwrap();
        let decoded = Frame::decode(Frame::Open(1, target).encode().freeze(), false).unwrap();
        assert!(matches!(decoded, Frame::Open(1, actual) if actual == target));
    }
}
