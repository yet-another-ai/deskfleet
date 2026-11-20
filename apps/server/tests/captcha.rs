//! Public authentication entry points enforce the installation's ALTCHA policy.
use actix_web::{App, cookie::Cookie, http::StatusCode, test, web};
use altcha::{Challenge, Payload, SolveChallengeOptions, solve_challenge};
use base64::{Engine, engine::general_purpose::STANDARD};
use deskfleet_server::{
    AppState,
    auth::config::{AuthConfig, GithubConfig, GoogleConfig, MailConfig},
    config::ServerConfig,
    configure,
};
use sea_orm::{ConnectionTrait, Database};
use serde_json::{Value, json};

const ORIGIN: &str = "http://localhost";
const CHALLENGE_PATH: &str = "/api/auth/captcha/challenge";

fn post(path: &str, csrf: &str, body: Value) -> test::TestRequest {
    test::TestRequest::post()
        .uri(path)
        .insert_header(("Origin", ORIGIN))
        .insert_header(("X-CSRF-Token", csrf))
        .cookie(Cookie::new("deskfleet_csrf", csrf.to_owned()))
        .set_json(body)
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn public_authentication_requires_an_action_bound_single_use_proof() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let database = Database::connect(&url).await.unwrap();
    let schema = format!("captcha_http_{}", uuid::Uuid::new_v4().simple());
    database
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let mail_directory = std::env::temp_dir().join(&schema);
    let mut auth = AuthConfig::development(ORIGIN);
    auth.mail = MailConfig::Local {
        directory: mail_directory.clone(),
    };
    auth.github = Some(GithubConfig {
        client_id: "github-client".into(),
        client_secret: "github-secret".into(),
        callback_url: format!("{ORIGIN}/api/auth/github/callback"),
        token_url: format!("{ORIGIN}/token"),
        user_url: format!("{ORIGIN}/userinfo"),
        emails_url: format!("{ORIGIN}/emails"),
    });
    auth.google = Some(GoogleConfig {
        client_id: "google-client".into(),
        client_secret: "google-secret".into(),
        callback_url: format!("{ORIGIN}/api/auth/google/callback"),
        token_url: format!("{ORIGIN}/token"),
        userinfo_url: format!("{ORIGIN}/userinfo"),
    });
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: format!("{url}{separator}options=-csearch_path%3D{schema}"),
            public_url: ORIGIN.into(),
            web_origins: vec![ORIGIN.into()],
            auth,
            billing: Default::default(),
            github_app: None,
            stun_urls: vec![],
            turn_urls: vec![],
            turn_secret: None,
            turn_usage_redis_url: None,
        })
        .await
        .unwrap(),
    );
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;

    let config_request = || {
        test::TestRequest::get()
            .uri("/api/auth/config")
            .to_request()
    };
    let config: Value = test::call_and_read_body_json(&app, config_request()).await;
    let csrf = config["csrfToken"].as_str().unwrap();
    assert_eq!(config["captchaEnabled"], false);
    let disabled = test::call_service(
        &app,
        post(CHALLENGE_PATH, csrf, json!({"action":"register"})).to_request(),
    )
    .await;
    assert_eq!(disabled.status(), StatusCode::NO_CONTENT);
    assert_eq!(disabled.headers().get("Cache-Control").unwrap(), "no-store");

    let admin = state
        .store
        .verified_user("captcha-admin@example.test", "Admin")
        .await
        .unwrap();
    let session = state.store.new_session(&admin.id).await.unwrap();
    let session_token = session["token"].as_str().unwrap();
    let toggle = |enabled| {
        test::TestRequest::patch()
            .uri("/api/auth/captcha")
            .insert_header(("Origin", ORIGIN))
            .insert_header(("X-CSRF-Token", csrf))
            .cookie(Cookie::new("deskfleet_csrf", csrf.to_owned()))
            .cookie(Cookie::new("deskfleet_session", session_token.to_owned()))
            .set_json(json!({"enabled":enabled}))
            .to_request()
    };
    let forbidden = test::call_service(&app, toggle(true)).await;
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    state.store.grant_site_admin(&admin.id).await.unwrap();
    let enabled = test::call_service(&app, toggle(true)).await;
    assert_eq!(enabled.status(), StatusCode::NO_CONTENT);
    let config: Value = test::call_and_read_body_json(&app, config_request()).await;
    assert_eq!(config["captchaEnabled"], true);
    for (path, body) in [
        (
            "/api/auth/login",
            json!({"email":"test@example.test","password":"attempt"}),
        ),
        ("/api/auth/register", json!({"email":"test@example.test"})),
        (
            "/api/auth/passkeys/login/options",
            json!({"email":"test@example.test"}),
        ),
        ("/api/auth/github/start", json!({"returnTo":"/"})),
        ("/api/auth/google/start", json!({"returnTo":"/"})),
    ] {
        let response = test::call_service(&app, post(path, csrf, body).to_request()).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
        let error: Value = test::read_body_json(response).await;
        assert_eq!(error["error"]["code"], "captcha_required", "{path}");
    }
    let unbound = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(CHALLENGE_PATH)
            .set_json(json!({"action":"register"}))
            .to_request(),
    )
    .await;
    assert_eq!(unbound.status(), StatusCode::FORBIDDEN);
    let issued = test::call_service(
        &app,
        post(CHALLENGE_PATH, csrf, json!({"action":"register"})).to_request(),
    )
    .await;
    assert_eq!(issued.status(), StatusCode::OK);
    assert_eq!(issued.headers().get("Cache-Control").unwrap(), "no-store");
    let challenge: Challenge = test::read_body_json(issued).await;
    let solution = solve_challenge(SolveChallengeOptions {
        counter_start: 1024,
        ..SolveChallengeOptions::new(&challenge)
    })
    .unwrap()
    .expect("challenge is solvable");
    let mut payload = Payload {
        challenge,
        solution,
    };
    let proof = STANDARD.encode(serde_json::to_vec(&payload).unwrap());
    let wrong_action = test::call_service(
        &app,
        post(
            "/api/auth/login",
            csrf,
            json!({"email":"test@example.test","password":"attempt","altcha":proof}),
        )
        .to_request(),
    )
    .await;
    assert_eq!(wrong_action.status(), StatusCode::FORBIDDEN);
    let error: Value = test::read_body_json(wrong_action).await;
    assert_eq!(error["error"]["code"], "captcha_invalid");

    payload.challenge.parameters.cost += 1;
    let tampered = STANDARD.encode(serde_json::to_vec(&payload).unwrap());
    let register = |proof: &str| {
        post(
            "/api/auth/register",
            csrf,
            json!({"email":"test@example.test","altcha":proof}),
        )
        .to_request()
    };
    let invalid = test::call_service(&app, register(&tampered)).await;
    assert_eq!(invalid.status(), StatusCode::FORBIDDEN);
    let error: Value = test::read_body_json(invalid).await;
    assert_eq!(error["error"]["code"], "captcha_invalid");

    let (first, second) = tokio::join!(
        test::call_service(&app, register(&proof)),
        test::call_service(&app, register(&proof)),
    );
    let (accepted, replay) = if first.status() == StatusCode::ACCEPTED {
        (first, second)
    } else {
        (second, first)
    };
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    assert_eq!(replay.status(), StatusCode::FORBIDDEN);
    let error: Value = test::read_body_json(replay).await;
    assert_eq!(error["error"]["code"], "captcha_invalid");
    assert_eq!(std::fs::read_dir(&mail_directory).unwrap().count(), 1);

    let disabled = test::call_service(&app, toggle(false)).await;
    assert_eq!(disabled.status(), StatusCode::NO_CONTENT);
    let config: Value = test::call_and_read_body_json(&app, config_request()).await;
    assert_eq!(config["captchaEnabled"], false);

    std::fs::remove_dir_all(mail_directory).unwrap();
    drop(app);
    drop(state);
    database
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
}
