mod image;
mod rich_messages;

use super::*;
use actix_web::{App, HttpServer, test};
use deskfleet_control_store::billing::Plan;
use sea_orm::{ConnectionTrait, Database, DatabaseConnection};
use serde_json::Value;
use statsig_rust::{Statsig, StatsigOptions};
use std::{
    net::{SocketAddr, TcpListener},
    sync::Arc,
    sync::atomic::{AtomicUsize, Ordering},
};

#[derive(Default)]
struct Calls {
    creates: AtomicUsize,
    sends: AtomicUsize,
}

fn check_secret(req: &HttpRequest) {
    assert_eq!(
        req.headers().get("authorization").unwrap(),
        "Bearer fixture-secret"
    );
}

struct TestSchema {
    admin: DatabaseConnection,
    name: String,
}

impl TestSchema {
    async fn close(self) {
        self.admin
            .execute_unprepared(&format!("DROP SCHEMA {} CASCADE", self.name))
            .await
            .unwrap();
    }
}

async fn fixture_state(address: SocketAddr) -> (TestSchema, AppState, Arc<Statsig>) {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let admin = Database::connect(&url).await.unwrap();
    let schema = format!("cloud_agent_{}", uuid::Uuid::new_v4().simple());
    admin
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let mut state = AppState::new(crate::config::ServerConfig {
        bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
        database_url: format!("{url}{separator}options=-csearch_path%3D{schema}"),
        public_url: "https://control.test".into(),
        web_origins: vec![],
        auth: crate::auth::config::AuthConfig::development("https://control.test"),
        billing: crate::billing::BillingConfig {
            hosted: true,
            ..Default::default()
        },
        github_app: None,
        stun_urls: vec![],
        turn_urls: vec![],
        turn_secret: None,
        turn_usage_redis_url: None,
    })
    .await
    .unwrap();
    let sdk = Arc::new(Statsig::new(
        "secret-fixture",
        Some(Arc::new(StatsigOptions {
            disable_network: Some(true),
            disable_all_logging: Some(true),
            ..Default::default()
        })),
    ));
    state.super_agent_rollout = Rollout::offline(Arc::clone(&sdk));
    let eve = EveClient::new(&format!("http://{address}"), "fixture-secret".into()).unwrap();
    state.eve = Some(eve);
    (
        TestSchema {
            admin,
            name: schema,
        },
        state,
        sdk,
    )
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn hosted_team_sessions_bind_before_delivery_and_replay_after_exhaustion() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let session_id = format!("wrun_{}", uuid::Uuid::new_v4().simple());
    let calls = web::Data::new(Calls::default());
    let upstream_calls = calls.clone();
    let id = session_id.clone();
    let server = HttpServer::new(move || {
        let stream_route = format!("/eve/v1/session/{id}/stream");
        let id = id.clone();
        App::new()
            .app_data(upstream_calls.clone())
            .route(
                "/eve/v1/session",
                web::post().to(
                    move |req: HttpRequest, body: web::Json<Value>, calls: web::Data<Calls>| {
                        let id = id.clone();
                        async move {
                            check_secret(&req);
                            assert_eq!(body["operationId"].as_str().unwrap().len(), 43);
                            assert!(body.get("message").is_none());
                            calls.creates.fetch_add(1, Ordering::SeqCst);
                            HttpResponse::Accepted().json(json!({"ok":true,"sessionId":id}))
                        }
                    },
                ),
            )
            .route(
                "/eve/v1/session/{id}",
                web::post().to(
                    |req: HttpRequest, body: web::Json<Value>, calls: web::Data<Calls>| async move {
                        check_secret(&req);
                        calls.sends.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(body["message"], "hello");
                        assert_eq!(body["idempotencyKey"].as_str().unwrap().len(), 43);
                        HttpResponse::Accepted().json(json!({"ok":true, "deliveryId":"delivery_1"}))
                    },
                ),
            )
            .route(
                &stream_route,
                web::get().to(|req: HttpRequest, calls: web::Data<Calls>| async move {
                    check_secret(&req);
                    let mut response = HttpResponse::Ok();
                    response.insert_header(("x-eve-stream-version", "27"));
                    if req.query_string() == "startIndex=7&follow=false" {
                        return response
                            .insert_header(("x-eve-stream-tail-index", "7"))
                            .body("{\"at\":\"2026-11-20T00:00:00Z\",\"facts\":[]}\n");
                    }
                    assert_eq!(req.query_string(), "startIndex=0&follow=false");
                    if calls.sends.load(Ordering::SeqCst) == 0 {
                        return response
                            .insert_header(("x-eve-stream-tail-index", "-1"))
                            .finish();
                    }
                    let line = json!({"at":chrono::Utc::now(), "facts":[
                        {"type":"usage.recorded","data":{"usage":{"inputTokens":2,"outputTokens":1}}},
                        {"type":"usage.recorded","data":{"usage":{"inputTokens":3,"outputTokens":2,
                          "cacheReadTokens":1,"cacheWriteTokens":1}}},
                        {"type":"session.ended","data":{"outcome":"completed"}}
                    ]});
                    response
                        .insert_header(("x-eve-stream-tail-index", "0"))
                        .body(format!("{line}\n"))
                }),
            )
    })
    .workers(1)
    .listen(listener)
    .unwrap()
    .run();
    let handle = server.handle();
    actix_web::rt::spawn(server);

    let (database, mut state, sdk) = fixture_state(address).await;
    state._cloud_meter = Some(crate::cloud_meter::start(
        state.store.clone(),
        state.eve.clone().unwrap(),
    ));
    let store = state.store.clone();
    let user = store
        .verified_user(&format!("super-{session_id}@fixture.test"), "Super Agent")
        .await
        .unwrap();
    store.grant_site_admin(&user.id).await.unwrap();
    let mut free = store.plan_limits(Plan::Free).await.unwrap();
    free.super_agent_tokens = Some(12);
    store
        .update_plan_limits(&user.id, Plan::Free, free)
        .await
        .unwrap();
    let rates = json!({"input":"1","output":"2","cacheRead":"0.25","cacheWrite":"3"});
    store
        .update_credit_rates(&user.id, serde_json::from_value(rates).unwrap())
        .await
        .unwrap();
    store.revoke_site_admin(&user.id).await.unwrap();
    let login = store.new_session(&user.id).await.unwrap();
    let token = format!("Bearer {}", login["token"].as_str().unwrap());
    let team = store
        .create_team(&user.id, "Super Agent API")
        .await
        .unwrap();
    let other = store.create_team(&user.id, "Separate Team").await.unwrap();
    let outsider = store
        .verified_user(&format!("outside-{session_id}@fixture.test"), "Outside")
        .await
        .unwrap();
    let outside_login = store.new_session(&outsider.id).await.unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(state))
            .configure(crate::configure),
    )
    .await;
    let path = format!("/api/teams/{}/super-agent/sessions", team.id);
    let create = json!({"operationId":uuid::Uuid::new_v4().to_string()});
    let post = |url: &str, body: Value| {
        test::TestRequest::post()
            .uri(url)
            .insert_header(("Authorization", token.as_str()))
            .set_json(body)
            .to_request()
    };
    let get = |url: &str| {
        test::TestRequest::get()
            .uri(url)
            .insert_header(("Authorization", token.as_str()))
            .to_request()
    };
    let unauth = test::TestRequest::post()
        .uri(&path)
        .insert_header(("Authorization", "Bearer invalid-fixture-token"))
        .set_json(&create)
        .to_request();
    assert_eq!(
        test::call_service(&app, unauth).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let forbidden = test::TestRequest::post()
        .uri(&path)
        .insert_header((
            "Authorization",
            format!("Bearer {}", outside_login["token"].as_str().unwrap()),
        ))
        .set_json(&create)
        .to_request();
    assert_eq!(
        test::call_service(&app, forbidden).await.status(),
        StatusCode::FORBIDDEN
    );
    let base = format!("/api/teams/{}/super-agent", team.id);
    let availability_path = format!("{base}/availability");
    let availability: Value = test::call_and_read_body_json(&app, get(&availability_path)).await;
    assert_eq!(availability, json!({"enabled":false}));
    let message_body = json!({"operationId":uuid::Uuid::new_v4().to_string(),"message":"hello"});
    for request in [
        post(&path, create.clone()),
        get(&path),
        post(&format!("{path}/{session_id}/messages"), message_body),
        get(&format!("{path}/{session_id}/stream")),
        get(&format!("{base}/usage")),
    ] {
        let response = test::call_service(&app, request).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
        let error: Value = test::read_body_json(response).await;
        assert_eq!(error["error"]["code"], "super_agent_disabled");
    }
    assert_eq!(calls.creates.load(Ordering::SeqCst), 0);
    assert_eq!(calls.sends.load(Ordering::SeqCst), 0);
    sdk.override_gate(rollout::GATE, true, Some(&team.id));
    let availability: Value = test::call_and_read_body_json(&app, get(&availability_path)).await;
    assert_eq!(availability, json!({"enabled":true}));
    let other_availability = format!("/api/teams/{}/super-agent/availability", other.id);
    let availability: Value = test::call_and_read_body_json(&app, get(&other_availability)).await;
    assert_eq!(availability, json!({"enabled":false}));
    sdk.override_gate(rollout::GATE, true, Some(&other.id));

    let (first, second) = futures_util::join!(
        test::call_service(&app, post(&path, create.clone())),
        test::call_service(&app, post(&path, create.clone())),
    );
    let statuses = [first.status(), second.status()];
    assert!(statuses.contains(&StatusCode::ACCEPTED));
    assert!(
        statuses
            .into_iter()
            .all(|status| matches!(status, StatusCode::ACCEPTED | StatusCode::CONFLICT))
    );
    let response: Value = test::call_and_read_body_json(&app, post(&path, create)).await;
    assert_eq!(response, json!({"sessionId":session_id}));
    assert!(
        store
            .owns_cloud_session(&team.id, &session_id)
            .await
            .unwrap()
    );
    let send_path = format!("{path}/{session_id}/messages");
    let body = json!({"operationId":uuid::Uuid::new_v4().to_string(),"message":"hello"});
    let cross_team = format!("/api/teams/{}/super-agent/sessions/{session_id}", other.id);
    assert_eq!(
        test::call_service(&app, post(&format!("{cross_team}/messages"), body.clone()))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        test::call_service(&app, get(&format!("{cross_team}/stream")))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let delivery: Value = test::call_and_read_body_json(&app, post(&send_path, body.clone())).await;
    assert_eq!(delivery["deliveryId"], "delivery_1");
    // Disabling the rollout blocks new reads/writes while the worker still
    // records the provider's usage for the delivery that was already accepted.
    sdk.override_gate(rollout::GATE, false, Some(&team.id));
    assert_eq!(
        test::call_service(&app, post(&send_path, body.clone()))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    tokio::time::timeout(Duration::from_secs(25), async {
        while store
            .cloud_token_period(&team.id)
            .await
            .unwrap()
            .used_tokens
            != 8
        {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("metered the Eve usage line while rollout was disabled");
    sdk.override_gate(rollout::GATE, true, Some(&team.id));
    let usage: Value = test::call_and_read_body_json(&app, get(&format!("{base}/usage"))).await;
    assert_eq!(usage["usedTokens"], 8);
    assert_eq!(usage["usedCredits"], "12.25");
    assert_eq!(usage["includedCredits"], 12);
    assert_eq!(usage["admitted"], false);
    let repeated: Value = test::call_and_read_body_json(&app, post(&send_path, body.clone())).await;
    assert_eq!(delivery, repeated);
    // A receipt written by the text-only gateway still replays without contacting Eve.
    let operation_id = uuid::Uuid::new_v4().to_string();
    let old_key = hash(&[&user.id, &team.id, &operation_id]);
    let old_fingerprint = hash(&["message", &session_id, "previous message"]);
    store
        .cloud_message_request(&team.id, &old_key, &old_fingerprint, &session_id, true)
        .await
        .unwrap();
    store
        .finish_cloud_agent_request(&old_key, "old_delivery")
        .await
        .unwrap();
    let old_body = json!({"operationId":operation_id, "message":"previous message"});
    let old_replay: Value = test::call_and_read_body_json(&app, post(&send_path, old_body)).await;
    assert_eq!(
        old_replay,
        json!({"sessionId":session_id, "deliveryId":"old_delivery"})
    );
    let mut changed = body.clone();
    changed["message"] = json!("different");
    assert_eq!(
        test::call_service(&app, post(&send_path, changed))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let mut next = body;
    next["operationId"] = json!(uuid::Uuid::new_v4().to_string());
    assert_eq!(
        test::call_service(&app, post(&send_path, next))
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    let listed: Value = test::call_and_read_body_json(&app, get(&path)).await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["sessionId"], session_id);
    assert_eq!(listed[0]["title"], "hello");
    assert!(listed[0]["lastActiveAt"].as_i64().unwrap() > 0);
    let other_sessions = format!("/api/teams/{}/super-agent/sessions", other.id);
    let separate: Value = test::call_and_read_body_json(&app, get(&other_sessions)).await;
    assert_eq!(separate, json!([]));
    let stream = test::call_service(
        &app,
        get(&format!("{path}/{session_id}/stream?startIndex=7")),
    )
    .await;
    assert_eq!(
        stream.headers().get("x-eve-stream-tail-index").unwrap(),
        "7"
    );
    assert!(test::read_body(stream).await.ends_with(b"\n"));
    assert_eq!(calls.creates.load(Ordering::SeqCst), 1);
    assert_eq!(calls.sends.load(Ordering::SeqCst), 1);
    drop(app);
    handle.stop(true).await;
    store.close().await.unwrap();
    database.close().await;
}
