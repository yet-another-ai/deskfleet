//! Branch PR reads require the user's App opt-in and keep refresh credentials central.
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, http::StatusCode, test, web};
use deskfleet_control_store::{GithubAppGrant, now_ms};
use deskfleet_server::{
    AppState, auth::config::AuthConfig, config::ServerConfig, configure,
    github_app::GithubAppConfig,
};
use sea_orm::{ConnectionTrait, Database};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

fn request(token: &str, branch: &str) -> test::TestRequest {
    let mut url = url::Url::parse("http://localhost/api/integrations/github/pull-request").unwrap();
    url.query_pairs_mut()
        .append_pair("owner", "upstream")
        .append_pair("repo", "project")
        .append_pair("branch", branch)
        .append_pair("headOwner", "octocat");
    test::TestRequest::get()
        .uri(&format!("{}?{}", url.path(), url.query().unwrap()))
        .insert_header(("Authorization", format!("Bearer {token}")))
}

fn grant(expired: bool) -> GithubAppGrant {
    GithubAppGrant {
        subject: "1234".into(),
        login: "octocat".into(),
        access_token: "ghu_fixture".into(),
        expires_at: Some(now_ms() + if expired { -1000 } else { 60_000 }),
        refresh_token: Some("ghr_fixture".into()),
        refresh_expires_at: Some(now_ms() + 60_000),
    }
}

#[actix_web::test]
#[ignore = "requires real PostgreSQL TEST_DATABASE_URL"]
async fn reads_branch_prs_with_opt_in_and_serializes_token_refresh() {
    let database_url = std::env::var("TEST_DATABASE_URL").unwrap();
    let database = Database::connect(&database_url).await.unwrap();
    let schema = format!("github_pr_{}", uuid::Uuid::new_v4().simple());
    database
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if database_url.contains('?') { '&' } else { '?' };
    let scoped_url = format!("{database_url}{separator}options=-csearch_path%3D{schema}");
    let refresh_calls = Arc::new(AtomicUsize::new(0));
    let pull_calls = Arc::new(AtomicUsize::new(0));
    let counters = (refresh_calls.clone(), pull_calls.clone());
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let mock = HttpServer::new(move || {
        let refresh_calls = counters.0.clone();
        let pull_calls = counters.1.clone();
        App::new()
            .route("/token", web::post().to(move |body: web::Form<HashMap<String, String>>| {
                let calls = refresh_calls.clone();
                async move {
                    assert_eq!(body.get("client_id").unwrap(), "app-client");
                    assert_eq!(body.get("client_secret").unwrap(), "app-secret");
                    assert_eq!(body.get("grant_type").unwrap(), "refresh_token");
                    assert_eq!(body.get("refresh_token").unwrap(), "ghr_fixture");
                    assert_eq!(calls.fetch_add(1, Ordering::SeqCst), 0, "refresh tokens are single use");
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    HttpResponse::Ok().json(json!({"access_token":"ghu_rotated", "token_type":"bearer",
                        "expires_in":28800, "refresh_token":"ghr_rotated", "refresh_token_expires_in":15897600}))
                }
            }))
            .route("/repos/upstream/project/pulls", web::get().to(move |req: HttpRequest, query: web::Query<HashMap<String,String>>| {
                let calls = pull_calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    let auth = req.headers().get("authorization").unwrap().to_str().unwrap();
                    assert!(auth == "Bearer ghu_fixture" || auth == "Bearer ghu_rotated");
                    assert_eq!(query.get("sort").unwrap(), "updated");
                    assert_eq!(query.get("direction").unwrap(), "desc");
                    assert_eq!(query.get("per_page").unwrap(), "1");
                    let head = query.get("head").unwrap().strip_prefix("octocat:").unwrap();
                    if head == "failure" {
                        return HttpResponse::Forbidden().json(json!({"message":"ghu_fixture must stay private"}));
                    }
                    let state = query.get("state").unwrap();
                    let closed = head == "merged" || head == "closed";
                    if head == "none" || (closed && state == "open") {
                        return HttpResponse::Ok().json(json!([]));
                    }
                    assert_eq!(state, if closed { "closed" } else { "open" });
                    HttpResponse::Ok().json(json!([{
                        "number": 78, "title":"Show PR state", "state":state, "draft": head == "draft",
                        "merged_at": if head == "merged" { Some("2026-10-30T00:00:00Z") } else { None },
                        "html_url":"javascript:untrusted-provider-url"
                    }]))
                }
            }))
    }).listen(listener).unwrap().run();
    let mock_handle = mock.handle();
    actix_web::rt::spawn(mock);
    let config = ServerConfig {
        bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
        database_url: scoped_url,
        public_url: "http://localhost".into(),
        web_origins: vec!["http://localhost".into()],
        auth: AuthConfig::development("http://localhost"),
        github_app: Some(GithubAppConfig {
            slug: "fixture".into(),
            client_id: "app-client".into(),
            client_secret: "app-secret".into(),
            callback_url: "http://localhost/api/integrations/github/callback".into(),
            token_url: format!("{origin}/token"),
            user_url: format!("{origin}/user"),
            api_url: origin,
        }),
        billing: Default::default(),
        stun_urls: vec![],
        turn_urls: vec![],
        turn_secret: None,
        turn_usage_redis_url: None,
    };
    let state = web::Data::new(AppState::new(config.clone()).await.unwrap());
    let user = state
        .store
        .verified_user("owner@example.test", "Owner")
        .await
        .unwrap();
    let other = state
        .store
        .verified_user("other@example.test", "Other")
        .await
        .unwrap();
    let session = state.store.new_session(&user.id).await.unwrap();
    let other_session = state.store.new_session(&other.id).await.unwrap();
    let token = session["token"].as_str().unwrap();
    let session_id = session["sessionId"].as_str().unwrap();
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;

    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/integrations/github/pull-request?owner=upstream&repo=project&branch=open")
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = test::call_service(&app, request(token, "open").to_request()).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    state
        .store
        .save_github_app_grant(&user.id, session_id, "app-client", grant(false))
        .await
        .unwrap();
    let response = test::call_service(&app, request(token, "open").to_request()).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(pull_calls.load(Ordering::SeqCst), 0);
    state
        .store
        .set_github_act_as_you(&user.id, "app-client", true)
        .await
        .unwrap();
    let response = test::call_service(
        &app,
        request(other_session["token"].as_str().unwrap(), "open").to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    for (branch, expected, requests) in [
        ("open", "open", 1),
        ("draft", "draft", 1),
        ("merged", "merged", 2),
        ("closed", "closed", 2),
        ("feat/a&state=closed", "open", 1),
    ] {
        let previous = pull_calls.load(Ordering::SeqCst);
        let response = test::call_service(&app, request(token, branch).to_request()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get("Cache-Control").unwrap(), "no-store");
        let body: Value = test::read_body_json(response).await;
        assert_eq!(body["pullRequest"]["state"], expected);
        assert_eq!(
            body["pullRequest"]["url"],
            "https://github.com/upstream/project/pull/78"
        );
        assert_eq!(pull_calls.load(Ordering::SeqCst) - previous, requests);
        assert!(!body.to_string().contains("ghu_"));
    }
    let response = test::call_service(&app, request(token, "none").to_request()).await;
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body, json!({"pullRequest":null}));
    let response = test::call_service(&app, request(token, "failure").to_request()).await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body: Value = test::read_body_json(response).await;
    assert!(!body.to_string().contains("ghu_"));
    assert_eq!(
        refresh_calls.load(Ordering::SeqCst),
        0,
        "valid access tokens need no refresh"
    );

    for query in [
        "owner=..&repo=project&branch=open",
        "owner=upstream&repo=..&branch=open",
        "owner=upstream&repo=project%2Fother&branch=open",
        "owner=upstream&repo=project&branch=",
        "owner=upstream&repo=project&branch=%0A",
    ] {
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/api/integrations/github/pull-request?{query}"))
                .insert_header(("Authorization", format!("Bearer {token}")))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    state
        .store
        .save_github_app_grant(&user.id, session_id, "app-client", grant(true))
        .await
        .unwrap();
    state
        .store
        .set_github_act_as_you(&user.id, "app-client", true)
        .await
        .unwrap();
    let (first, second) = tokio::join!(
        test::call_service(&app, request(token, "open").to_request()),
        test::call_service(&app, request(token, "open").to_request()),
    );
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(refresh_calls.load(Ordering::SeqCst), 1);
    let access = state
        .store
        .github_app_access(&user.id, "app-client")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(access.tokens.access_token, "ghu_rotated");
    assert_eq!(access.tokens.refresh_token.as_deref(), Some("ghr_rotated"));
    access.finish(None).await.unwrap();
    assert!(
        state
            .store
            .github_app_status(&user.id, "app-client")
            .await
            .unwrap()
            .act_as_you
    );

    state
        .store
        .set_github_act_as_you(&user.id, "app-client", false)
        .await
        .unwrap();
    let previous = pull_calls.load(Ordering::SeqCst);
    let response = test::call_service(&app, request(token, "open").to_request()).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(pull_calls.load(Ordering::SeqCst), previous);
    assert_eq!(refresh_calls.load(Ordering::SeqCst), 1);

    let mut config = config;
    config.github_app.as_mut().unwrap().client_id = "different-app".into();
    let changed = web::Data::new(AppState::new(config).await.unwrap());
    let changed_app = test::init_service(App::new().app_data(changed).configure(configure)).await;
    state
        .store
        .set_github_act_as_you(&user.id, "app-client", true)
        .await
        .unwrap();
    let response = test::call_service(&changed_app, request(token, "open").to_request()).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    mock_handle.stop(true).await;
    database
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
}
