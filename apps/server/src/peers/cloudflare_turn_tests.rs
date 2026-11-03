//! Site configuration, issued credentials and actual background usage ingestion.
use super::*;
use actix_web::{App, HttpResponse, HttpServer};
use deskfleet_control_store::{TurnUsage, TurnUsageSide};
use deskfleet_protocol::control::TeamTurnSettingsUpdate;
use std::{net::TcpListener, sync::Mutex};

#[derive(Default)]
struct Provider {
    identifiers: Vec<String>,
}

async fn provider(body: web::Json<Value>, state: web::Data<Mutex<Provider>>) -> HttpResponse {
    if body.get("query").is_some() {
        return HttpResponse::Ok().json(json!({"data":{"viewer":{"accounts":[{
            "callsTurnUsageAdaptiveGroups":[{"sum":{"egressBytes":101}}]
        }]}}}));
    }
    let mut state = state.lock().unwrap();
    state
        .identifiers
        .push(body["customIdentifier"].as_str().unwrap().to_owned());
    let index = state.identifiers.len();
    HttpResponse::Created().json(json!({"iceServers":[{
        "urls":["turn:cloudflare.example.test:3478?transport=udp"],
        "username":format!("cf-user-{index}"),"credential":format!("cf-password-{index}")
    }]}))
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn cloudflare_settings_grants_and_collector_share_team_usage() {
    crate::initialize_tls_provider();
    let listener = TcpListener::bind("[::1]:0")
        .or_else(|_| TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let provider_state = web::Data::new(Mutex::new(Provider::default()));
    let data = provider_state.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(data.clone())
            .route(
                "/ready",
                web::get().to(|| async { HttpResponse::Ok().finish() }),
            )
            .default_service(web::post().to(provider))
    })
    .workers(1)
    .listen(listener)
    .unwrap()
    .run();
    let handle = server.handle();
    let task = actix_web::rt::spawn(server);
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if http.get(format!("{origin}/ready")).send().await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("mock Cloudflare listener must be reachable before issuing credentials");
    let mut fixture = Fixture::with_cloudflare(
        vec![],
        vec!["turn:coturn.example.test:3478".into()],
        Some("self-hosted-secret"),
        Some(&origin),
    )
    .await;
    let app = test::init_service(
        App::new()
            .app_data(fixture.a.clone())
            .configure(crate::configure),
    )
    .await;
    let settings = json!({
        "enabled":true,"accountId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "keyId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "apiToken":"turn-api-secret","analyticsToken":"analytics-secret"
    });
    macro_rules! call {
        ($method:ident, $body:expr) => {
            test::call_service(
                &app,
                test::TestRequest::$method()
                    .uri("/api/admin/cloudflare-turn-settings")
                    .insert_header(("Authorization", format!("Bearer {}", fixture.token)))
                    .set_json($body)
                    .to_request(),
            )
            .await
        };
    }
    let anonymous = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/admin/cloudflare-turn-settings")
            .to_request(),
    )
    .await;
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(call!(get, &json!({})).status(), StatusCode::FORBIDDEN);
    assert_eq!(call!(patch, &settings).status(), StatusCode::FORBIDDEN);
    let user = fixture
        .a
        .store
        .authenticate(&fixture.token)
        .await
        .unwrap()
        .user;
    fixture.a.store.grant_site_admin(&user.id).await.unwrap();
    let response = call!(patch, &settings);
    assert_eq!(response.status(), StatusCode::OK);
    let saved: Value = test::read_body_json(response).await;
    assert_eq!(saved["apiTokenConfigured"], true);
    assert_eq!(saved["analyticsTokenConfigured"], true);
    assert!(saved.get("apiToken").is_none());
    assert!(saved.get("analyticsToken").is_none());

    let first = turn_settings_tests::create_grant(&fixture, fixture.a.clone()).await;
    let second = turn_settings_tests::create_grant(&fixture, fixture.b.clone()).await;
    assert_eq!(first["iceServers"].as_array().unwrap().len(), 2);
    assert_eq!(
        first["iceServers"][0]["urls"][0],
        "turn:coturn.example.test:3478"
    );
    assert_eq!(first["iceServers"][1]["username"], "cf-user-1");
    assert_eq!(second["iceServers"][1]["username"], "cf-user-2");
    {
        let state = provider_state.lock().unwrap();
        assert_eq!(state.identifiers.len(), 2);
        assert_eq!(state.identifiers[0], state.identifiers[1]);
        assert_ne!(state.identifiers[0], fixture.team);
    }
    // Disabling stops new credentials immediately but keeps issued ICE snapshots
    // and analytics access for the outstanding credentials.
    let mut disabled = settings.clone();
    disabled["enabled"] = json!(false);
    disabled.as_object_mut().unwrap().remove("apiToken");
    disabled.as_object_mut().unwrap().remove("analyticsToken");
    assert_eq!(call!(patch, &disabled).status(), StatusCode::OK);
    let third = turn_settings_tests::create_grant(&fixture, fixture.b.clone()).await;
    assert_eq!(third["iceServers"].as_array().unwrap().len(), 1);
    let peer = first["peerId"].as_str().unwrap().to_owned();
    let sdp = peers::tests::sdp();
    let offer = start_offer(
        fixture.b.clone(),
        fixture.token.clone(),
        peer.clone(),
        sdp.clone(),
    );
    let (id, params) = fixture.next_request("peer.offer").await;
    assert_eq!(params["iceServers"], first["iceServers"]);
    fixture.response(&id, json!({"sdp":sdp})).await;
    offer.await.unwrap().unwrap();

    fixture
        .a
        .store
        .record_turn_usage(&TurnUsage {
            peer_id: peer,
            realm: "site".into(),
            allocation_id: "allocation-1".into(),
            side: TurnUsageSide::Client,
            received_bytes: 400,
            sent_bytes: 17,
            collected_at: now_ms(),
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let summary = fixture
                .a
                .store
                .billing_summary(&fixture.team)
                .await
                .unwrap();
            if summary["usage"]["relayedBytes"] == "118" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("background collector must add Cloudflare egress to coturn usage");

    // A Team's own TURN remains a replacement for all site providers.
    assert_eq!(call!(patch, &settings).status(), StatusCode::OK);
    fixture
        .a
        .store
        .update_team_turn_settings(
            &user.id,
            &fixture.team,
            &TeamTurnSettingsUpdate {
                urls: vec!["turn:team.example.test:3478".into()],
                secret: Some("team-secret".into()),
            },
        )
        .await
        .unwrap();
    let team_grant = turn_settings_tests::create_grant(&fixture, fixture.b.clone()).await;
    assert_eq!(team_grant["iceServers"].as_array().unwrap().len(), 1);
    assert_eq!(
        team_grant["iceServers"][0]["urls"][0],
        "turn:team.example.test:3478"
    );
    assert_eq!(provider_state.lock().unwrap().identifiers.len(), 2);
    let public: Value = test::read_body_json(
        test::call_service(&app, test::TestRequest::get().uri("/api/site").to_request()).await,
    )
    .await;
    assert!(!public.to_string().contains("analytics-secret"));
    assert!(!public.to_string().contains("turn-api-secret"));
    assert!(public.get("cloudflareTurn").is_none());
    fixture.a.store.revoke_site_admin(&user.id).await.unwrap();
    assert_eq!(call!(get, &json!({})).status(), StatusCode::FORBIDDEN);
    drop(app);
    fixture.close().await;
    handle.stop(true).await;
    task.await.unwrap().unwrap();
}
