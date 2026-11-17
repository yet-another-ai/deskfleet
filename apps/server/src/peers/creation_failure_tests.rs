//! Setup failures retain their cause even when durable revocation or notice fails.

use super::*;
use actix_web::{App, HttpResponse, HttpServer};
use deskfleet_protocol::control::CloudflareTurnSettingsUpdate;
use std::{
    net::TcpListener,
    sync::atomic::{AtomicUsize, Ordering},
};

#[derive(Clone, Copy)]
enum CleanupFault {
    Revoke,
    Notify,
}

async fn inject_cleanup_failure(fixture: &Fixture, fault: CleanupFault) {
    let db = fixture.a.store.database();
    db.execute_unprepared(
        "CREATE FUNCTION reject_peer_cleanup() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected cleanup failure'; END; $$ LANGUAGE plpgsql",
    )
    .await
    .unwrap();
    let trigger = match fault {
        CleanupFault::Revoke => {
            "CREATE TRIGGER reject_peer_cleanup BEFORE UPDATE ON cp_peers FOR EACH ROW WHEN (NEW.revoked AND NOT OLD.revoked) EXECUTE FUNCTION reject_peer_cleanup()"
        }
        CleanupFault::Notify => {
            "CREATE TRIGGER reject_peer_cleanup BEFORE INSERT ON cp_realtime_messages FOR EACH ROW EXECUTE FUNCTION reject_peer_cleanup()"
        }
    };
    db.execute_unprepared(trigger).await.unwrap();
}

async fn peer_revoked(fixture: &Fixture) -> bool {
    let rows = fixture
        .a
        .store
        .database()
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT revoked FROM cp_peers",
        ))
        .await
        .unwrap();
    assert_eq!(
        rows.len(),
        1,
        "the failed request reserved exactly one grant"
    );
    rows[0].try_get("", "revoked").unwrap()
}

async fn turn_error_survives_cleanup(fault: CleanupFault) {
    crate::initialize_tls_provider();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let requests = web::Data::new(AtomicUsize::new(0));
    let data = requests.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(data.clone())
            .default_service(
                web::post().to(|requests: web::Data<AtomicUsize>| async move {
                    requests.fetch_add(1, Ordering::Relaxed);
                    HttpResponse::ServiceUnavailable().finish()
                }),
            )
    })
    .workers(1)
    .listen(listener)
    .unwrap()
    .run();
    let handle = server.handle();
    let task = actix_web::rt::spawn(server);
    let fixture = Fixture::with_cloudflare(vec![], vec![], None, Some(&origin)).await;
    let user = fixture
        .a
        .store
        .authenticate(&fixture.token)
        .await
        .unwrap()
        .user;
    fixture.a.store.grant_site_admin(&user.id).await.unwrap();
    fixture
        .a
        .store
        .update_cloudflare_turn_settings(
            &user.id,
            &CloudflareTurnSettingsUpdate {
                enabled: true,
                account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                key_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
                api_token: Some("fixture-api-token".into()),
                analytics_token: Some("fixture-analytics-token".into()),
            },
        )
        .await
        .unwrap();
    inject_cleanup_failure(&fixture, fault).await;
    let error = peers::create(
        request(&fixture.token),
        fixture.a.clone(),
        web::Json(peers::Create {
            team_id: fixture.team.clone(),
            machine_id: fixture.machine.clone(),
            purpose: "agent".into(),
        }),
    )
    .await
    .unwrap_err();
    let revoked = peer_revoked(&fixture).await;
    fixture.close().await;
    handle.stop(true).await;
    task.await.unwrap().unwrap();

    assert!(
        requests.load(Ordering::Relaxed) > 0,
        "the TURN provider failed"
    );
    assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error.code, "turn_service_unavailable");
    assert_eq!(error.message, "Cloudflare TURN service is unavailable");
    assert_eq!(error.reason, None);
    assert_eq!(revoked, matches!(fault, CleanupFault::Notify));
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn turn_error_survives_failed_revocation() {
    turn_error_survives_cleanup(CleanupFault::Revoke).await;
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn turn_error_survives_failed_notification() {
    turn_error_survives_cleanup(CleanupFault::Notify).await;
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn local_error_survives_failed_notification() {
    let mut fixture = Fixture::new().await;
    // Use the daemon's node so its reply does not itself need the failed inbox.
    let state = fixture.b.clone();
    let token = fixture.token.clone();
    let body = peers::Create {
        team_id: fixture.team.clone(),
        machine_id: fixture.machine.clone(),
        purpose: "agent".into(),
    };
    let creating = actix_web::rt::spawn(async move {
        peers::create_local(request(&token), state, web::Json(body)).await
    });
    let (id, _) = fixture.next_request("peer.local").await;
    inject_cleanup_failure(&fixture, CleanupFault::Notify).await;
    let mut primary = ApiError::bad("fixture daemon could not create local channel");
    primary.reason = Some("encoder".into());
    fixture
        .b
        .hub
        .response(&fixture.registration, "daemon-b", &id, Err(primary))
        .await;
    let error = creating.await.unwrap().unwrap_err();
    let revoked = peer_revoked(&fixture).await;
    fixture.close().await;

    assert_eq!(error.status, StatusCode::BAD_REQUEST);
    assert_eq!(error.code, "invalid_request");
    assert_eq!(
        error.message,
        "fixture daemon could not create local channel"
    );
    assert_eq!(error.reason.as_deref(), Some("encoder"));
    assert!(revoked);
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn negotiation_error_survives_failed_notification() {
    let mut fixture = Fixture::new().await;
    let peer = fixture.peer().await;
    let offering = start_offer(
        fixture.b.clone(),
        fixture.token.clone(),
        peer,
        peers::tests::sdp(),
    );
    let (id, _) = fixture.next_request("peer.offer").await;
    inject_cleanup_failure(&fixture, CleanupFault::Notify).await;
    fixture
        .b
        .hub
        .response(
            &fixture.registration,
            "daemon-b",
            &id,
            Err(ApiError::bad("fixture daemon rejected offer")),
        )
        .await;
    let error = offering.await.unwrap().unwrap_err();
    let revoked = peer_revoked(&fixture).await;
    fixture.close().await;

    assert_eq!(error.status, StatusCode::BAD_REQUEST);
    assert_eq!(error.code, "invalid_request");
    assert_eq!(error.message, "fixture daemon rejected offer");
    assert!(revoked);
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn withdrawn_offer_error_survives_failed_notification() {
    let mut fixture = Fixture::new().await;
    let peer = fixture.peer().await;
    let sdp = peers::tests::sdp();
    let offering = start_offer(fixture.b.clone(), fixture.token.clone(), peer, sdp.clone());
    let (id, _) = fixture.next_request("peer.offer").await;
    fixture
        .a
        .store
        .revoke_login_peers(&fixture.login)
        .await
        .unwrap();
    inject_cleanup_failure(&fixture, CleanupFault::Notify).await;
    fixture.response(&id, json!({"sdp":sdp})).await;
    let error = offering.await.unwrap().unwrap_err();
    let revoked = peer_revoked(&fixture).await;
    fixture.close().await;

    assert_eq!(error.status, StatusCode::NOT_FOUND);
    assert_eq!(error.code, "not_found");
    assert_eq!(error.message, "resource not found");
    assert!(revoked);
}
