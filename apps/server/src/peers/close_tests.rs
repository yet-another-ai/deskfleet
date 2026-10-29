//! PostgreSQL regression for acknowledged cleanup after peer grants become inactive.

use std::time::Duration;

use actix_web::{App, http::StatusCode, test};
use deskfleet_protocol::control::ControlMessage;
use tokio::sync::{mpsc, watch};

use super::*;

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn inactive_desktop_close_keeps_owner_checks_and_waits_for_daemon_cleanup() {
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL"),
            public_url: "https://control.test".into(),
            web_origins: vec![],
            auth: crate::auth::config::AuthConfig::development("https://control.test"),
            billing: Default::default(),
            stun_urls: vec![],
            turn_urls: vec![],
            turn_secret: None,
            turn_usage_redis_url: None,
        })
        .await
        .unwrap(),
    );
    let issuer = format!("https://fixture/{}", uuid::Uuid::new_v4());
    let user = state
        .store
        .verified_user(
            &format!("owner-{}@fixture.test", issuer.rsplit('/').next().unwrap()),
            "Owner",
        )
        .await
        .unwrap();
    let team = state.store.create_team(&user.id, "Control").await.unwrap();
    let (machine, _) = state
        .store
        .enroll(
            &user.id,
            &team.id,
            "Desktop",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    let login = state.store.new_session(&user.id).await.unwrap();
    let token = login["token"].as_str().unwrap();
    let actor = state.store.authenticate(token).await.unwrap();
    let other_login = state.store.new_session(&user.id).await.unwrap();
    let other_token = other_login["token"].as_str().unwrap();
    let (send, mut requests) = mpsc::channel(8);
    let (shutdown, _shutdown) = watch::channel(None);
    state
        .hub
        .add_daemon(&machine.id, "fixture", send, shutdown)
        .await
        .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(state.clone())
            .configure(crate::configure),
    )
    .await;

    for revoked in [true, false] {
        let now = now_ms();
        let expires = if revoked { now + 60_000 } else { now - 1 };
        let grant = PeerAuthorization {
            peer_id: uuid::Uuid::new_v4().to_string(),
            server_id: state.config.public_url.clone(),
            team_id: team.id.clone(),
            actor: api::actor(&actor),
            target_machine: PeerTarget {
                id: machine.id.clone(),
                origin_id: machine.origin_id.clone(),
                local_machine_id: "1".into(),
            },
            purpose: "desktop".into(),
            transport: PeerTransport::Webrtc,
            actions: vec!["desktop:stream".into(), "desktop:control".into()],
            issued_at: timestamp(now - 60_000),
            expires_at: timestamp(expires),
        };
        state
            .store
            .save_peer(&grant, &actor.id, expires)
            .await
            .unwrap();
        if revoked {
            state.store.revoke_peer(&grant.peer_id).await.unwrap();
        }
        // Expired/revoked grants still cannot start a stream or resume operations.
        assert!(state.store.peer(&grant.peer_id, &actor.id).await.is_err());
        let path = format!("/api/peers/{}", grant.peer_id);
        let denied = test::call_service(
            &app,
            test::TestRequest::delete()
                .uri(&path)
                .insert_header(("Authorization", format!("Bearer {other_token}")))
                .to_request(),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::NOT_FOUND);
        assert!(requests.try_recv().is_err());

        // Both the initial close and a retry must await the native cleanup receipt.
        for _ in 0..2 {
            let closing = test::call_service(
                &app,
                test::TestRequest::delete()
                    .uri(&path)
                    .insert_header(("Authorization", format!("Bearer {token}")))
                    .to_request(),
            );
            tokio::pin!(closing);
            let request_id = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    tokio::select! {
                        response = &mut closing => panic!("close returned before cleanup: {}", response.status()),
                        message = requests.recv() => match message.expect("daemon route remains open") {
                            ControlMessage::PeerRevoked { peer_id, .. } => assert_eq!(peer_id, grant.peer_id),
                            ControlMessage::Request { id, method, params, .. } => {
                                assert_eq!(method, "peer.close");
                                assert_eq!(params["peerId"], grant.peer_id);
                                break id;
                            }
                            _ => panic!("unexpected daemon message"),
                        },
                    }
                }
            })
            .await
            .expect("desktop close must request cleanup for an inactive grant");
            assert!(
                tokio::time::timeout(Duration::from_millis(20), &mut closing)
                    .await
                    .is_err()
            );
            state
                .hub
                .response(&machine.id, "fixture", &request_id, Ok(json!({})))
                .await;
            assert_eq!(closing.await.status(), StatusCode::OK);
        }
        assert!(state.store.peer(&grant.peer_id, &actor.id).await.is_err());
    }
    state.store.close().await.unwrap();
}
