//! Local grants retain shared authorization without entering the SDP/ICE path.

use super::*;
use deskfleet_protocol::control::PeerTransport;

fn start_local(
    fixture: &Fixture,
    purpose: &str,
) -> tokio::task::JoinHandle<Result<web::Json<Value>>> {
    let state = fixture.a.clone();
    let token = fixture.token.clone();
    let body = peers::Create {
        team_id: fixture.team.clone(),
        machine_id: fixture.machine.clone(),
        purpose: purpose.into(),
    };
    actix_web::rt::spawn(async move {
        peers::create_local(request(&token), state, web::Json(body)).await
    })
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn local_grants_wait_for_trusted_delivery_without_ice_and_reject_signaling() {
    let mut fixture = Fixture::new().await;
    for purpose in ["agent", "terminal"] {
        let mut creating = start_local(&fixture, purpose);
        let (request_id, params) = fixture.next_request("peer.local").await;
        assert_eq!(params["authorization"]["transport"], "local");
        assert_eq!(params["authorization"]["purpose"], purpose);
        assert_eq!(
            params["authorization"]["targetMachine"]["id"],
            fixture.machine
        );
        assert_eq!(params["authorization"]["actor"]["deviceId"], fixture.login);
        assert_eq!(params["authorization"]["teamId"], fixture.team);
        let secret = params["token"].as_str().unwrap();
        assert!(secret.len() >= 64);
        assert!(params.get("iceServers").is_none());
        assert!(params.get("relayAllowed").is_none());
        assert!(params["authorization"].get("token").is_none());
        let issued = chrono::DateTime::parse_from_rfc3339(
            params["authorization"]["issuedAt"].as_str().unwrap(),
        )
        .unwrap();
        let expires = chrono::DateTime::parse_from_rfc3339(
            params["authorization"]["expiresAt"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!((expires - issued).num_hours(), 24);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut creating)
                .await
                .is_err()
        );
        fixture.response(&request_id, json!({})).await;
        let response = creating.await.unwrap().unwrap();
        assert_eq!(response.into_inner(), params);
        let peer = params["peerId"].as_str().unwrap();
        let stored = fixture.a.store.peer(peer, &fixture.login).await.unwrap();
        assert_eq!(stored.transport, PeerTransport::Local);
        assert!(!serde_json::to_string(&stored).unwrap().contains(secret));
        // No relay entitlement or negotiation state is created for a local grant.
        assert!(!fixture.a.store.peer_relay_decision(peer).await.unwrap());
        let other = fixture
            .a
            .store
            .new_session(&stored.actor.user_id)
            .await
            .unwrap();
        assert!(
            fixture
                .a
                .store
                .peer(peer, other["sessionId"].as_str().unwrap())
                .await
                .is_err()
        );
        let failed = offer(
            request(&fixture.token),
            fixture.a.clone(),
            peer.to_owned().into(),
            web::Json(Offer {
                sdp: peers::tests::sdp(),
                options: Value::Null,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(failed.status, StatusCode::FORBIDDEN);
        let failed = candidate(
            request(&fixture.token),
            fixture.a.clone(),
            peer.to_owned().into(),
            web::Json(Candidate {
                candidate: candidate_value(10000),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(failed.status, StatusCode::FORBIDDEN);
        assert!(fixture.requests.try_recv().is_err());
        assert!(
            fixture
                .a
                .store
                .valid_machine_peers(&fixture.machine)
                .await
                .unwrap()
                .iter()
                .any(|grant| grant.peer_id == peer && grant.transport == PeerTransport::Local)
        );
        peers::close(
            request(&fixture.token),
            fixture.a.clone(),
            peer.to_owned().into(),
        )
        .await
        .unwrap();
        assert!(fixture.a.store.peer(peer, &fixture.login).await.is_err());
        let revoked = tokio::time::timeout(Duration::from_secs(5), fixture.requests.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(revoked, ControlMessage::PeerRevoked { peer_id, .. } if peer_id == peer));
    }
    fixture.close().await;
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn local_grants_revoke_when_daemon_rejects_or_login_is_revoked_during_delivery() {
    let mut fixture = Fixture::new().await;
    let creating = start_local(&fixture, "agent");
    let (id, params) = fixture.next_request("peer.local").await;
    fixture
        .b
        .hub
        .response(
            &fixture.machine,
            "daemon-b",
            &id,
            Err(ApiError::bad("local channel unavailable")),
        )
        .await;
    assert_eq!(
        creating.await.unwrap().unwrap_err().status,
        StatusCode::BAD_REQUEST
    );
    assert!(
        fixture
            .a
            .store
            .peer(params["peerId"].as_str().unwrap(), &fixture.login)
            .await
            .is_err()
    );
    let message = tokio::time::timeout(Duration::from_secs(5), fixture.requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(message, ControlMessage::PeerRevoked { .. }));

    let creating = start_local(&fixture, "terminal");
    let (id, params) = fixture.next_request("peer.local").await;
    fixture.a.store.logout(&fixture.login).await.unwrap();
    fixture.response(&id, json!({})).await;
    assert_eq!(
        creating.await.unwrap().unwrap_err().status,
        StatusCode::UNAUTHORIZED
    );
    assert!(
        fixture
            .a
            .store
            .peer(params["peerId"].as_str().unwrap(), &fixture.login)
            .await
            .is_err()
    );
    assert!(
        fixture
            .a
            .store
            .valid_machine_peers(&fixture.machine)
            .await
            .unwrap()
            .is_empty()
    );
    fixture.close().await;
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn local_endpoint_rejects_unauthorized_or_non_message_purposes() {
    let fixture = Fixture::new().await;
    let app = test::init_service(
        actix_web::App::new()
            .app_data(fixture.a.clone())
            .configure(crate::configure),
    )
    .await;
    for purpose in ["desktop", "files", "ports"] {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/peers/local")
                .insert_header(("Authorization", format!("Bearer {}", fixture.token)))
                .set_json(
                    json!({"teamId":fixture.team,"machineId":fixture.machine,"purpose":purpose}),
                )
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/peers/local")
            .insert_header(("Authorization", "Bearer invalid-login"))
            .set_json(json!({"teamId":fixture.team,"machineId":fixture.machine,"purpose":"agent"}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(
        fixture
            .a
            .store
            .valid_machine_peers(&fixture.machine)
            .await
            .unwrap()
            .is_empty()
    );
    drop(app);
    fixture.close().await;
}
