//! Browser binding and replay protection for GitHub OAuth.
use actix_web::{App, HttpResponse, HttpServer, cookie::Cookie, http::StatusCode, test, web};
use deskfleet_server::{
    AppState,
    auth::config::{AuthConfig, GithubConfig},
    config::ServerConfig,
    configure,
};
use sea_orm::{ConnectionTrait, Database};
use serde_json::{Value, json};

#[actix_web::test]
#[ignore = "requires real PostgreSQL TEST_DATABASE_URL"]
async fn github_callback_is_bound_to_browser_and_single_use() {
    let database_url = std::env::var("TEST_DATABASE_URL").unwrap();
    let database = Database::connect(&database_url).await.unwrap();
    let schema = format!("github_http_{}", uuid::Uuid::new_v4().simple());
    database
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if database_url.contains('?') { '&' } else { '?' };
    let scoped_url = format!("{database_url}{separator}options=-csearch_path%3D{schema}");
    let scoped_database = Database::connect(&scoped_url).await.unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mock_origin = format!("http://{}", listener.local_addr().unwrap());
    let email = format!("github-{}@example.test", uuid::Uuid::new_v4());
    let subject = uuid::Uuid::new_v4().as_u64_pair().0;
    let mock = HttpServer::new(move || {
        let email = email.clone();
        App::new()
            .route(
                "/token",
                web::post().to(|| async {
                    HttpResponse::Ok().json(json!({"access_token": "fixture-token"}))
                }),
            )
            .route(
                "/user",
                web::get().to(move || async move {
                    HttpResponse::Ok()
                        .json(json!({"id":subject,"login":"fixture","name":"GitHub User"}))
                }),
            )
            .route(
                "/emails",
                web::get().to(move || {
                    let email = email.clone();
                    async move {
                        HttpResponse::Ok()
                            .json(json!([{ "email":email, "verified":true, "primary":true }]))
                    }
                }),
            )
    })
    .listen(listener)
    .unwrap()
    .run();
    let handle = mock.handle();
    actix_web::rt::spawn(mock);
    let mut auth = AuthConfig::development("http://localhost");
    auth.github = Some(GithubConfig {
        client_id: "fixture-client".into(),
        client_secret: "fixture-secret".into(),
        callback_url: "http://localhost/api/auth/github/callback".into(),
        token_url: format!("{mock_origin}/token"),
        user_url: format!("{mock_origin}/user"),
        emails_url: format!("{mock_origin}/emails"),
    });
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: scoped_url,
            public_url: "http://localhost".into(),
            web_origins: vec!["http://localhost".into()],
            auth,
            billing: Default::default(),
            stun_urls: vec![],
            turn_urls: vec![],
            turn_secret: None,
            turn_usage_redis_url: None,
        })
        .await
        .unwrap(),
    );
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;
    let csrf = "github-test-csrf-token-32-characters";
    let start_with_terms = |return_to: &str, accepted_terms: bool| {
        test::TestRequest::post()
            .uri("/api/auth/github/start")
            .insert_header(("Origin", "http://localhost"))
            .insert_header(("X-CSRF-Token", csrf))
            .cookie(Cookie::new("deskfleet_csrf", csrf))
            .set_json(json!({"returnTo": return_to, "acceptedTerms": accepted_terms}))
            .to_request()
    };
    let start = |return_to: &str| start_with_terms(return_to, true);
    let no_terms = test::call_service(&app, start_with_terms("/auth/login", false)).await;
    assert_eq!(no_terms.status(), StatusCode::OK);
    scoped_database
        .execute_unprepared("UPDATE cp_site_settings SET terms_of_service_url='https://example.test/terms' WHERE singleton")
        .await
        .unwrap();
    let missing_consent = test::call_service(&app, start_with_terms("/auth/login", false)).await;
    assert_eq!(missing_consent.status(), StatusCode::BAD_REQUEST);
    let error: Value = test::read_body_json(missing_consent).await;
    assert_eq!(error["error"]["code"], "terms_acceptance_required");
    let accepted = test::call_service(&app, start("/auth/login")).await;
    assert_eq!(accepted.status(), StatusCode::OK);
    scoped_database
        .execute_unprepared("UPDATE cp_site_settings SET terms_of_service_url='' WHERE singleton")
        .await
        .unwrap();
    let invalid = test::call_service(&app, start("//attacker.example")).await;
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    let response = test::call_service(&app, start("/auth/login")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let binding = response
        .response()
        .cookies()
        .find(|c| c.name() == "deskfleet_github_state")
        .unwrap();
    assert_eq!(binding.http_only(), Some(true));
    let binding = binding.into_owned();
    let body: Value = test::read_body_json(response).await;
    let url = url::Url::parse(body["authorizationUrl"].as_str().unwrap()).unwrap();
    let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(query.get("state").unwrap(), binding.value());
    assert_eq!(query.get("code_challenge_method").unwrap(), "S256");
    assert_eq!(
        query.get("redirect_uri").unwrap(),
        "http://localhost/api/auth/github/callback"
    );
    let callback = format!("/api/auth/github/callback?state={}", binding.value());
    let unbound =
        test::call_service(&app, test::TestRequest::get().uri(&callback).to_request()).await;
    assert_eq!(unbound.status(), StatusCode::UNAUTHORIZED);
    let denied = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&callback)
            .cookie(binding.clone())
            .to_request(),
    )
    .await;
    assert_eq!(denied.status(), StatusCode::FOUND);
    assert_eq!(
        denied.headers().get("Location").unwrap(),
        "http://localhost/auth/login?githubError=failed"
    );
    let replay = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&callback)
            .cookie(binding)
            .to_request(),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    let response = test::call_service(&app, start("/auth/login")).await;
    let binding = response
        .response()
        .cookies()
        .find(|c| c.name() == "deskfleet_github_state")
        .unwrap()
        .into_owned();
    let callback = format!(
        "/api/auth/github/callback?state={}&code=fixture",
        binding.value()
    );
    let success = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&callback)
            .cookie(binding)
            .to_request(),
    )
    .await;
    assert_eq!(success.status(), StatusCode::FOUND);
    assert_eq!(
        success.headers().get("Location").unwrap(),
        "http://localhost/auth/login"
    );
    let session = success
        .response()
        .cookies()
        .find(|c| c.name() == "deskfleet_session")
        .unwrap();
    assert_eq!(session.http_only(), Some(true));
    let session = session.into_owned();
    let signed_in_start = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/auth/github/start")
            .insert_header(("Origin", "http://localhost"))
            .insert_header(("X-CSRF-Token", csrf))
            .cookie(Cookie::new("deskfleet_csrf", csrf))
            .cookie(session.clone())
            .set_json(json!({"returnTo":"/auth/login","acceptedTerms":true}))
            .to_request(),
    )
    .await;
    assert_eq!(signed_in_start.status(), StatusCode::FORBIDDEN);
    let me = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/me")
            .cookie(session)
            .to_request(),
    )
    .await;
    assert_eq!(me.status(), StatusCode::OK);
    let me: Value = test::read_body_json(me).await;
    assert_eq!(me["user"]["name"], "GitHub User");
    // A newly configured policy also applies to an outstanding sign-in attempt.
    let response = test::call_service(&app, start_with_terms("/auth/login", false)).await;
    let binding = response
        .response()
        .cookies()
        .find(|c| c.name() == "deskfleet_github_state")
        .unwrap()
        .into_owned();
    scoped_database
        .execute_unprepared("UPDATE cp_site_settings SET privacy_terms_url='https://example.test/privacy' WHERE singleton")
        .await
        .unwrap();
    let callback = format!(
        "/api/auth/github/callback?state={}&code=fixture",
        binding.value()
    );
    let denied = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&callback)
            .cookie(binding)
            .to_request(),
    )
    .await;
    assert_eq!(
        denied.headers().get("Location").unwrap(),
        "http://localhost/auth/login?githubError=terms_required"
    );
    scoped_database
        .execute_unprepared("UPDATE cp_site_settings SET privacy_terms_url='' WHERE singleton")
        .await
        .unwrap();
    // Revoking all sessions fences a GitHub login begun before the revocation.
    let response = test::call_service(&app, start("/auth/login")).await;
    let binding = response
        .response()
        .cookies()
        .find(|c| c.name() == "deskfleet_github_state")
        .unwrap()
        .into_owned();
    state
        .store
        .revoke_user_sessions(me["user"]["id"].as_str().unwrap(), None)
        .await
        .unwrap();
    let callback = format!(
        "/api/auth/github/callback?state={}&code=fixture",
        binding.value()
    );
    let revoked = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&callback)
            .cookie(binding)
            .to_request(),
    )
    .await;
    assert_eq!(revoked.status(), StatusCode::FOUND);
    assert_eq!(
        revoked.headers().get("Location").unwrap(),
        "http://localhost/auth/login?githubError=failed"
    );
    assert!(
        revoked
            .response()
            .cookies()
            .all(|c| c.name() != "deskfleet_session")
    );
    handle.stop(true).await;
    scoped_database.close().await.unwrap();
    database
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    database.close().await.unwrap();
}
