//! Exercise the socket's actual bounded worker with shared PostgreSQL signaling.
use super::*;
use crate::websocket::peer_events::PeerEvents;
use std::collections::HashSet;

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_early_ice_burst_preserves_machine_and_delivers_every_candidate() {
    let mut fixture = Fixture::new().await;
    let peer = fixture.peer().await;
    let sdp = peers::tests::sdp();
    let answer = sdp.replace("ice-ufrag:one", "ice-ufrag:two");
    let creating = {
        let state = fixture.a.clone();
        let peer = peer.clone();
        let token = fixture.token.clone();
        actix_web::rt::spawn(async move {
            offer(
                request(&token),
                state,
                peer.into(),
                web::Json(Offer {
                    sdp,
                    options: Value::Null,
                }),
            )
            .await
        })
    };
    let (offer_id, _) = fixture.next_request("peer.offer").await;
    let incoming = PeerEvents::new(
        fixture.b.clone(),
        fixture.registration.clone(),
        "daemon-b".into(),
    );
    // Two desktop thumbnails can easily emit more than the old 16-task /64Hz
    // socket limits while the native SDP answer has not yet been returned.
    for port in 10_000..10_080 {
        incoming.push(
            peer.clone(),
            json!({"kind":"iceCandidate","candidate":candidate_value(port)}),
        );
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(50), fixture.events.recv())
            .await
            .is_err()
    );
    assert!(
        fixture
            .b
            .hub
            .is_current(&fixture.registration, "daemon-b")
            .await
    );
    // An RPC response must remain processable while all signaling workers wait.
    fixture.response(&offer_id, json!({"sdp":answer})).await;
    assert_eq!(creating.await.unwrap().unwrap()["sdp"], answer);
    let mut received = HashSet::new();
    tokio::time::timeout(Duration::from_secs(10), async {
        while received.len() < 80 {
            match fixture.events.recv().await.unwrap() {
                ControlMessage::PeerEvent { peer_id, event } => {
                    assert_eq!(peer_id, peer);
                    assert_eq!(event["candidate"]["usernameFragment"], "two");
                    assert_eq!(event["candidate"]["sdpMid"], "data");
                    received.insert(event["candidate"]["candidate"].as_str().unwrap().to_owned());
                }
                other => panic!("unexpected event: {other:?}"),
            }
        }
    })
    .await
    .expect("every admitted candidate reaches its viewer");
    assert!(
        fixture
            .b
            .hub
            .is_current(&fixture.registration, "daemon-b")
            .await
    );
    assert!(fixture.a.store.peer(&peer, &fixture.login).await.is_ok());
    drop(incoming);
    fixture.close().await;
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_event_overflow_rejects_only_its_peer_and_keeps_control_rpc_working() {
    let mut fixture = Fixture::new().await;
    let noisy = fixture.peer().await;
    let unrelated = fixture.peer().await;
    fixture
        .a
        .store
        .prepare_peer_offer(&noisy, &peers::tests::sdp(), &Value::Null)
        .await
        .unwrap();
    let incoming = PeerEvents::new(
        fixture.b.clone(),
        fixture.registration.clone(),
        "daemon-b".into(),
    );
    // Enqueue without yielding: overflow is deterministic, not scheduler timing.
    for port in 10_000..10_300 {
        incoming.push(
            noisy.clone(),
            json!({"kind":"iceCandidate","candidate":candidate_value(port)}),
        );
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.a.store.peer(&noisy, &fixture.login).await.is_ok() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("overflow rejects the affected negotiation");
    assert!(
        fixture
            .a
            .store
            .peer(&unrelated, &fixture.login)
            .await
            .is_ok()
    );
    assert!(
        fixture
            .b
            .hub
            .is_current(&fixture.registration, "daemon-b")
            .await
    );
    let rpc = {
        let state = fixture.b.clone();
        let registration = fixture.registration.clone();
        actix_web::rt::spawn(async move {
            state
                .hub
                .request(&registration, "systemStatus", json!({}), None)
                .await
        })
    };
    let request_id = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let ControlMessage::Request { id, method, .. } =
                fixture.requests.recv().await.unwrap()
            {
                assert_eq!(method, "systemStatus");
                break id;
            }
        }
    })
    .await
    .unwrap();
    fixture.response(&request_id, json!({"online":true})).await;
    assert_eq!(rpc.await.unwrap().unwrap(), json!({"online":true}));
    drop(incoming);
    fixture.close().await;
}
