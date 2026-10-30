//! GitHub App grants remain separate from login identity and belong to one account.
use actix_web::{App, HttpResponse, HttpServer, cookie::Cookie, http::StatusCode, test, web};
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

const CSRF: &str = "github-app-test-csrf-token-32-characters";

fn browser_request(token: &str) -> test::TestRequest {
    test::TestRequest::default()
        .insert_header(("Origin", "http://localhost"))
        .insert_header(("X-CSRF-Token", CSRF))
        .cookie(Cookie::new("deskfleet_csrf", CSRF))
        .cookie(Cookie::new("deskfleet_session", token.to_owned()))
}

#[actix_web::test]
#[ignore = "requires real PostgreSQL TEST_DATABASE_URL"]
async fn github_app_authorization_is_account_bound_and_explicitly_enabled() {
    let database_url = std::env::var("TEST_DATABASE_URL").unwrap();
    let database = Database::connect(&database_url).await.unwrap();
    let schema = format!("github_app_http_{}", uuid::Uuid::new_v4().simple());
    database
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if database_url.contains('?') { '&' } else { '?' };
    let scoped_url = format!("{database_url}{separator}options=-csearch_path%3D{schema}");
    let token_calls = Arc::new(AtomicUsize::new(0));
    let calls = token_calls.clone();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mock_origin = format!("http://{}", listener.local_addr().unwrap());
    let mock = HttpServer::new(move || {
        let calls = calls.clone();
        App::new()
            .route("/token", web::post().to(move |body: web::Form<HashMap<String,String>>| {
                let calls = calls.clone();
                async move {
                    assert_eq!(body.get("client_id").map(String::as_str), Some("app-client"));
                    assert_eq!(body.get("client_secret").map(String::as_str), Some("app-secret"));
                    assert_eq!(body.get("redirect_uri").map(String::as_str), Some("http://localhost/api/integrations/github/callback"));
                    assert!(!body.contains_key("scope"));
                    calls.fetch_add(1, Ordering::SeqCst);
                    let mut token = json!({"access_token":"ghu_fixture","refresh_token":"ghr_fixture","expires_in":28800,"refresh_token_expires_in":15897600,"token_type":"bearer"});
                    match body.get("code").map(String::as_str) {
                        Some("incomplete-refresh") => { token.as_object_mut().unwrap().remove("refresh_token_expires_in"); }
                        Some("wrong-token-type") => token["token_type"] = json!("mac"),
                        Some("empty-token") => token["access_token"] = json!(""),
                        _ => {}
                    }
                    HttpResponse::Ok().json(token)
                }
            }))
            .route("/user", web::get().to(|req: actix_web::HttpRequest| async move {
                assert_eq!(req.headers().get("authorization").unwrap(), "Bearer ghu_fixture");
                HttpResponse::Ok().json(json!({"id": 1234, "login":"octocat"}))
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
            slug: "deskfleet-fixture".into(),
            client_id: "app-client".into(),
            client_secret: "app-secret".into(),
            callback_url: "http://localhost/api/integrations/github/callback".into(),
            token_url: format!("{mock_origin}/token"),
            user_url: format!("{mock_origin}/user"),
        }),
        billing: Default::default(),
        stun_urls: vec![],
        turn_urls: vec![],
        turn_secret: None,
        turn_usage_redis_url: None,
    };
    let state = web::Data::new(AppState::new(config.clone()).await.unwrap());
    let owner = state
        .store
        .verified_user("owner@example.test", "Owner")
        .await
        .unwrap();
    let other = state
        .store
        .verified_user("other@example.test", "Other")
        .await
        .unwrap();
    let owner_session = state.store.new_session(&owner.id).await.unwrap();
    let owner_token = owner_session["token"].as_str().unwrap();
    let other_session = state.store.new_session(&other.id).await.unwrap();
    let other_token = other_session["token"].as_str().unwrap();
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;

    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/integrations/github")
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = test::call_service(
        &app,
        browser_request(owner_token)
            .uri("/api/integrations/github")
            .to_request(),
    )
    .await;
    let status: Value = test::read_body_json(response).await;
    assert_eq!(status["configured"], true);
    assert_eq!(
        status["manageUrl"],
        "https://github.com/apps/deskfleet-fixture/installations/new"
    );
    assert_eq!(status["authorized"], false);
    assert_eq!(status["actAsYou"], false);

    let response = test::call_service(
        &app,
        browser_request(owner_token)
            .method(actix_web::http::Method::PATCH)
            .uri("/api/integrations/github")
            .set_json(json!({"actAsYou":true}))
            .to_request(),
    )
    .await;
    assert!(response.status().is_client_error());
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/integrations/github/authorization/start")
            .cookie(Cookie::new("deskfleet_session", owner_token.to_owned()))
            .set_json(json!({"expectedUserId":owner.id}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/integrations/github/authorization/start")
            .insert_header(("Authorization", format!("Bearer {owner_token}")))
            .set_json(json!({"expectedUserId":owner.id}))
            .to_request(),
    )
    .await;
    assert!(response.status().is_client_error());
    let response = test::call_service(
        &app,
        browser_request(owner_token)
            .method(actix_web::http::Method::POST)
            .uri("/api/integrations/github/authorization/start")
            .set_json(json!({"expectedUserId":other.id}))
            .to_request(),
    )
    .await;
    assert!(response.status().is_client_error());

    let start = || {
        browser_request(owner_token)
            .method(actix_web::http::Method::POST)
            .uri("/api/integrations/github/authorization/start")
            .set_json(json!({"expectedUserId":owner.id}))
            .to_request()
    };
    let response = test::call_service(&app, start()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let binding = response
        .response()
        .cookies()
        .find(|cookie| cookie.name() == "deskfleet_github_app_state")
        .unwrap()
        .into_owned();
    assert_eq!(binding.http_only(), Some(true));
    let body: Value = test::read_body_json(response).await;
    let url = url::Url::parse(body["authorizationUrl"].as_str().unwrap()).unwrap();
    let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(query.get("client_id").unwrap(), "app-client");
    assert_eq!(query.get("state").unwrap(), binding.value());
    assert!(!query.contains_key("scope"));
    let callback = format!(
        "/api/integrations/github/callback?state={}&code=fixture",
        binding.value()
    );
    let unbound = test::call_service(
        &app,
        browser_request(owner_token).uri(&callback).to_request(),
    )
    .await;
    assert!(unbound.status().is_client_error());
    assert_eq!(token_calls.load(Ordering::SeqCst), 0);
    let response = test::call_service(
        &app,
        browser_request(owner_token)
            .uri(&callback)
            .cookie(binding.clone())
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FOUND);
    let location = response
        .headers()
        .get("Location")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(location.contains("githubAppResult=authorized"));
    // Connecting the App never replaces or creates a DeskFleet login cookie.
    assert!(
        response
            .response()
            .cookies()
            .all(|cookie| cookie.name() != "deskfleet_session")
    );
    let replay = test::call_service(
        &app,
        browser_request(owner_token)
            .uri(&callback)
            .cookie(binding)
            .to_request(),
    )
    .await;
    assert!(replay.status().is_client_error());
    assert_eq!(token_calls.load(Ordering::SeqCst), 1);

    let response = test::call_service(
        &app,
        browser_request(owner_token)
            .uri("/api/integrations/github")
            .to_request(),
    )
    .await;
    let status: Value = test::read_body_json(response).await;
    assert_eq!(status["authorized"], true);
    assert_eq!(status["login"], "octocat");
    assert_eq!(status["actAsYou"], false);
    let serialized = status.to_string();
    assert!(!serialized.contains("ghu_fixture") && !serialized.contains("ghr_fixture"));
    let response = test::call_service(
        &app,
        browser_request(other_token)
            .uri("/api/integrations/github")
            .to_request(),
    )
    .await;
    let status: Value = test::read_body_json(response).await;
    assert_eq!(status["authorized"], false);
    for enabled in [true, false] {
        let response = test::call_service(
            &app,
            browser_request(owner_token)
                .method(actix_web::http::Method::PATCH)
                .uri("/api/integrations/github")
                .set_json(json!({"actAsYou":enabled}))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let response = test::call_service(
            &app,
            browser_request(owner_token)
                .uri("/api/integrations/github")
                .to_request(),
        )
        .await;
        let status: Value = test::read_body_json(response).await;
        assert_eq!(status["authorized"], true);
        assert_eq!(status["actAsYou"], enabled);
    }

    // Another DeskFleet account cannot complete the owner's outstanding App grant.
    let response = test::call_service(&app, start()).await;
    let binding = response
        .response()
        .cookies()
        .find(|cookie| cookie.name() == "deskfleet_github_app_state")
        .unwrap()
        .into_owned();
    let callback = format!(
        "/api/integrations/github/callback?state={}&code=fixture",
        binding.value()
    );
    let response = test::call_service(
        &app,
        browser_request(other_token)
            .uri(&callback)
            .cookie(binding)
            .to_request(),
    )
    .await;
    assert!(
        response.status().is_client_error()
            || response
                .headers()
                .get("Location")
                .unwrap()
                .to_str()
                .unwrap()
                .contains("githubAppResult=failed")
    );
    assert_eq!(token_calls.load(Ordering::SeqCst), 1);

    // Logout/revocation during the provider trip prevents the callback from saving a grant.
    let response = test::call_service(&app, start()).await;
    let binding = response
        .response()
        .cookies()
        .find(|cookie| cookie.name() == "deskfleet_github_app_state")
        .unwrap()
        .into_owned();
    state
        .store
        .revoke_user_sessions(&owner.id, None)
        .await
        .unwrap();
    let callback = format!(
        "/api/integrations/github/callback?state={}&code=fixture",
        binding.value()
    );
    let response = test::call_service(
        &app,
        browser_request(owner_token)
            .uri(&callback)
            .cookie(binding)
            .to_request(),
    )
    .await;
    assert!(
        response.status().is_client_error()
            || response
                .headers()
                .get("Location")
                .unwrap()
                .to_str()
                .unwrap()
                .contains("githubAppResult=failed")
    );
    assert_eq!(token_calls.load(Ordering::SeqCst), 1);

    let new_session = state.store.new_session(&owner.id).await.unwrap();
    let new_token = new_session["token"].as_str().unwrap();
    let mut changed_config = config.clone();
    changed_config.github_app.as_mut().unwrap().client_id = "different-app".into();
    let changed_state = web::Data::new(AppState::new(changed_config).await.unwrap());
    let changed_app = test::init_service(
        App::new()
            .app_data(changed_state.clone())
            .configure(configure),
    )
    .await;
    let response = test::call_service(
        &changed_app,
        browser_request(new_token)
            .uri("/api/integrations/github")
            .to_request(),
    )
    .await;
    let status: Value = test::read_body_json(response).await;
    assert_eq!(status["authorized"], false);
    assert_eq!(status["actAsYou"], false);

    let mut disabled_config = config;
    disabled_config.github_app = None;
    let disabled_state = web::Data::new(AppState::new(disabled_config).await.unwrap());
    let disabled_app = test::init_service(
        App::new()
            .app_data(disabled_state.clone())
            .configure(configure),
    )
    .await;
    let response = test::call_service(
        &disabled_app,
        browser_request(new_token)
            .uri("/api/integrations/github")
            .to_request(),
    )
    .await;
    let status: Value = test::read_body_json(response).await;
    assert_eq!(status["configured"], false);
    assert_eq!(status["authorized"], false);
    assert_eq!(status["actAsYou"], false);

    // Expired access tokens remain authorized while a valid refresh grant exists.
    state
        .store
        .database()
        .execute_unprepared("UPDATE cp_github_app_authorizations SET expires_at=0")
        .await
        .unwrap();
    let response = test::call_service(
        &app,
        browser_request(new_token)
            .uri("/api/integrations/github")
            .to_request(),
    )
    .await;
    let status: Value = test::read_body_json(response).await;
    assert_eq!(status["authorized"], true);
    state
        .store
        .database()
        .execute_unprepared("UPDATE cp_github_app_authorizations SET refresh_expires_at=0")
        .await
        .unwrap();
    let response = test::call_service(
        &app,
        browser_request(new_token)
            .uri("/api/integrations/github")
            .to_request(),
    )
    .await;
    let status: Value = test::read_body_json(response).await;
    assert_eq!(status["authorized"], false);
    assert_eq!(status["actAsYou"], false);
    let response = test::call_service(
        &app,
        browser_request(new_token)
            .method(actix_web::http::Method::PATCH)
            .uri("/api/integrations/github")
            .set_json(json!({"actAsYou":true}))
            .to_request(),
    )
    .await;
    assert!(response.status().is_client_error());

    // Malformed provider replies cannot replace the expired grant with a usable one.
    for code in ["incomplete-refresh", "wrong-token-type", "empty-token"] {
        let response = test::call_service(
            &app,
            browser_request(new_token)
                .method(actix_web::http::Method::POST)
                .uri("/api/integrations/github/authorization/start")
                .set_json(json!({"expectedUserId": owner.id}))
                .to_request(),
        )
        .await;
        let binding = response
            .response()
            .cookies()
            .find(|cookie| cookie.name() == "deskfleet_github_app_state")
            .unwrap()
            .into_owned();
        let callback = format!(
            "/api/integrations/github/callback?state={}&code={code}",
            binding.value()
        );
        let response = test::call_service(
            &app,
            browser_request(new_token)
                .uri(&callback)
                .cookie(binding)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FOUND);
        assert!(
            response
                .headers()
                .get("Location")
                .unwrap()
                .to_str()
                .unwrap()
                .contains("githubAppResult=failed")
        );
        let response = test::call_service(
            &app,
            browser_request(new_token)
                .uri("/api/integrations/github")
                .to_request(),
        )
        .await;
        let status: Value = test::read_body_json(response).await;
        assert_eq!(status["authorized"], false);
    }

    mock_handle.stop(true).await;
    state.store.close().await.unwrap();
    changed_state.store.close().await.unwrap();
    disabled_state.store.close().await.unwrap();
    database
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    database.close().await.unwrap();
}
