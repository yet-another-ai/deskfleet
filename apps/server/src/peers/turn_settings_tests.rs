//! Runtime administration must affect new grants across API instances, not issued grants.
use super::*;
use actix_web::App;

async fn create_grant(fixture: &Fixture, state: web::Data<AppState>) -> Value {
    peers::create(
        request(&fixture.token),
        state,
        web::Json(peers::Create {
            team_id: fixture.team.clone(),
            machine_id: fixture.machine.clone(),
            purpose: "agent".into(),
        }),
    )
    .await
    .unwrap()
    .into_inner()
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn turn_settings_http_authorization_and_live_grants() {
    let mut fixture = Fixture::with_turn_secret(Some("turn-test-secret")).await;
    let app = test::init_service(
        App::new()
            .app_data(fixture.a.clone())
            .configure(crate::configure),
    )
    .await;
    macro_rules! call {
        ($method:ident, $body:expr) => {
            test::call_service(
                &app,
                test::TestRequest::$method()
                    .uri("/api/admin/turn-settings")
                    .insert_header(("Authorization", format!("Bearer {}", fixture.token)))
                    .set_json($body)
                    .to_request(),
            )
            .await
        };
    }
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/admin/turn-settings")
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let first = json!({"urls": ["turn:first.example.test:3478?transport=udp"]});
    assert_eq!(call!(get, &json!({})).status(), StatusCode::FORBIDDEN);
    assert_eq!(call!(patch, &first).status(), StatusCode::FORBIDDEN);
    let user = fixture
        .a
        .store
        .authenticate(&fixture.token)
        .await
        .unwrap()
        .user;
    fixture.a.store.grant_site_admin(&user.id).await.unwrap();
    let initial: Value = test::read_body_json(call!(get, &json!({}))).await;
    assert_eq!(initial, json!({"urls": []}));
    assert_eq!(
        call!(patch, &json!({"urls": ["https://invalid.test"]})).status(),
        StatusCode::BAD_REQUEST
    );
    let saved: Value = test::read_body_json(call!(patch, &first)).await;
    assert_eq!(saved, first);
    let issued = create_grant(&fixture, fixture.a.clone()).await;
    assert_eq!(issued["iceServers"][0]["urls"], first["urls"]);
    assert!(issued["iceServers"][0]["credential"].is_string());

    let second = json!({"urls": [
        "turn:second.example.test:3478?transport=udp",
        "turns:second.example.test:5349?transport=tcp"
    ]});
    assert_eq!(call!(patch, &second).status(), StatusCode::OK);
    // An already-running independent API instance issues the new list immediately.
    let fresh = create_grant(&fixture, fixture.b.clone()).await;
    assert_eq!(fresh["iceServers"][0]["urls"], second["urls"]);
    assert_eq!(fixture.a.config.turn_urls, Vec::<String>::new());

    // Offer forwarding on the other API instance retains the issued ICE snapshot.
    let peer = issued["peerId"].as_str().unwrap().to_owned();
    let sdp = peers::tests::sdp();
    let pending = start_offer(fixture.b.clone(), fixture.token.clone(), peer, sdp.clone());
    let (id, params) = fixture.next_request("peer.offer").await;
    assert_eq!(params["iceServers"], issued["iceServers"]);
    fixture.response(&id, json!({"sdp": sdp})).await;
    pending.await.unwrap().unwrap();

    assert_eq!(call!(patch, &json!({"urls": []})).status(), StatusCode::OK);
    let cleared = create_grant(&fixture, fixture.b.clone()).await;
    assert_eq!(cleared["iceServers"], json!([]));
    let public: Value = test::read_body_json(
        test::call_service(&app, test::TestRequest::get().uri("/api/site").to_request()).await,
    )
    .await;
    assert!(public.get("urls").is_none());
    assert!(public.get("turnSettings").is_none());
    fixture.a.store.revoke_site_admin(&user.id).await.unwrap();
    assert_eq!(call!(get, &json!({})).status(), StatusCode::FORBIDDEN);
    assert_eq!(call!(patch, &first).status(), StatusCode::FORBIDDEN);
    drop(app);
    fixture.close().await;
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn turn_settings_requires_a_deployment_secret_for_nonempty_lists() {
    let fixture = Fixture::new().await;
    let user = fixture
        .a
        .store
        .authenticate(&fixture.token)
        .await
        .unwrap()
        .user;
    fixture.a.store.grant_site_admin(&user.id).await.unwrap();
    let app = test::init_service(
        App::new()
            .app_data(fixture.a.clone())
            .configure(crate::configure),
    )
    .await;
    let response = test::call_service(
        &app,
        test::TestRequest::patch()
            .uri("/api/admin/turn-settings")
            .insert_header(("Authorization", format!("Bearer {}", fixture.token)))
            .set_json(json!({"urls": ["turn:relay.test:3478"]}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = test::read_body_json(response).await;
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("DESKFLEET_TURN_SECRET")
    );
    assert!(
        fixture
            .a
            .store
            .turn_settings()
            .await
            .unwrap()
            .urls
            .is_empty()
    );
    // A failed first startup must not persist a list that cannot issue credentials.
    fixture
        .a
        .store
        .database()
        .execute_unprepared("DELETE FROM cp_turn_settings")
        .await
        .unwrap();
    let mut config = fixture.a.config.clone();
    config.turn_urls = vec!["turn:relay.test:3478".into()];
    assert!(
        crate::turn_settings::initialize(&fixture.a.store, &config)
            .await
            .is_err()
    );
    assert!(matches!(
        fixture.a.store.turn_settings().await,
        Err(deskfleet_control_store::Error::NotFound)
    ));
    config.turn_urls.clear();
    crate::turn_settings::initialize(&fixture.a.store, &config)
        .await
        .unwrap();
    // Once initialized, a deployment seed never replaces an intentionally empty list.
    config.turn_urls = vec!["turn:old-seed.test:3478".into()];
    crate::turn_settings::initialize(&fixture.a.store, &config)
        .await
        .unwrap();
    assert!(
        fixture
            .a
            .store
            .turn_settings()
            .await
            .unwrap()
            .urls
            .is_empty()
    );
    drop(app);
    fixture.close().await;
}
