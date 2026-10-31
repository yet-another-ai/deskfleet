//! Google OAuth preserves browser binding, account ownership, and login continuations.
use actix_web::{
    App, HttpRequest, HttpResponse, HttpServer,
    cookie::Cookie,
    dev::{ServerHandle, ServiceResponse},
    http::StatusCode,
    test, web,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use deskfleet_server::{
    AppState,
    auth::config::{AuthConfig, GithubConfig, GoogleConfig},
    config::ServerConfig,
    configure,
};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

const CSRF: &str = "google-test-csrf-token-32-characters";
const CALLBACK: &str = "http://localhost/api/auth/google/callback";
type TokenExchanges = Arc<Mutex<Vec<HashMap<String, String>>>>;

struct Fixture {
    state: web::Data<AppState>,
    database: DatabaseConnection,
    schema: String,
    mock: ServerHandle,
    exchanges: TokenExchanges,
}

impl Fixture {
    async fn new() -> Self {
        let database_url = std::env::var("TEST_DATABASE_URL").unwrap();
        let database = Database::connect(&database_url).await.unwrap();
        let schema = format!("google_http_{}", uuid::Uuid::new_v4().simple());
        database
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if database_url.contains('?') { '&' } else { '?' };
        let scoped_url = format!("{database_url}{separator}options=-csearch_path%3D{schema}");
        let exchanges = Arc::new(Mutex::new(Vec::new()));
        let recorded = exchanges.clone();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = HttpServer::new(move || {
            App::new()
                .app_data(web::Data::new(recorded.clone()))
                .route("/token", web::post().to(token))
                .route("/userinfo", web::get().to(userinfo))
        })
        .workers(1)
        .listen(listener)
        .unwrap()
        .run();
        let mock = server.handle();
        actix_web::rt::spawn(server);
        let mut auth = AuthConfig::development("http://localhost");
        auth.google = Some(GoogleConfig {
            client_id: "google-client".into(),
            client_secret: "google-secret".into(),
            callback_url: CALLBACK.into(),
            token_url: format!("{origin}/token"),
            userinfo_url: format!("{origin}/userinfo"),
        });
        auth.github = Some(GithubConfig {
            client_id: "github-client".into(),
            client_secret: "github-secret".into(),
            callback_url: "http://localhost/api/auth/github/callback".into(),
            token_url: format!("{origin}/token"),
            user_url: format!("{origin}/userinfo"),
            emails_url: format!("{origin}/emails"),
        });
        let state = web::Data::new(
            AppState::new(ServerConfig {
                bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
                database_url: scoped_url,
                public_url: "http://localhost".into(),
                web_origins: vec!["http://localhost".into()],
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
        Self {
            state,
            database,
            schema,
            mock,
            exchanges,
        }
    }

    async fn sql(&self, sql: &str) {
        self.state
            .store
            .database()
            .execute_unprepared(sql)
            .await
            .unwrap();
    }

    async fn finish(self) {
        self.mock.stop(true).await;
        self.database
            .execute_unprepared(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
        self.database.close().await.unwrap();
    }
}

async fn token(
    body: web::Form<HashMap<String, String>>,
    exchanges: web::Data<TokenExchanges>,
) -> HttpResponse {
    assert_eq!(body.get("grant_type").unwrap(), "authorization_code");
    assert_eq!(body.get("client_id").unwrap(), "google-client");
    assert_eq!(body.get("client_secret").unwrap(), "google-secret");
    assert_eq!(body.get("redirect_uri").unwrap(), CALLBACK);
    assert!(body.get("code_verifier").unwrap().len() >= 43);
    exchanges.lock().unwrap().push((*body).clone());
    if body.get("code").unwrap() == "token-error" {
        return HttpResponse::BadRequest().json(json!({"error":"invalid_grant"}));
    }
    HttpResponse::Ok().json(json!({"access_token":body.get("code").unwrap()}))
}

async fn userinfo(req: HttpRequest) -> HttpResponse {
    let code = req
        .headers()
        .get("Authorization")
        .unwrap()
        .to_str()
        .unwrap()
        .strip_prefix("Bearer ")
        .unwrap();
    let mut profile = json!({"sub":"google-user","email":"google@example.test","email_verified":true,"name":"Google User"});
    match code {
        "userinfo-error" => return HttpResponse::Unauthorized().finish(),
        "unverified" => {
            profile["sub"] = json!(code);
            profile["email_verified"] = json!(false);
        }
        "missing-email" => {
            profile["sub"] = json!(code);
            profile.as_object_mut().unwrap().remove("email");
        }
        "missing-verification" => {
            profile["sub"] = json!(code);
            profile.as_object_mut().unwrap().remove("email_verified");
        }
        "empty-subject" => profile["sub"] = json!(""),
        "email-conflict" => {
            profile["sub"] = json!(code);
            profile["email"] = json!("existing@example.test");
        }
        "new-user" => {
            profile["sub"] = json!(code);
            profile["email"] = json!("new@example.test");
        }
        "existing-no-email" => {
            profile.as_object_mut().unwrap().remove("email");
            profile["email_verified"] = json!(false);
        }
        _ => {}
    }
    HttpResponse::Ok().json(profile)
}

fn start(return_to: &str, accepted_terms: bool) -> test::TestRequest {
    test::TestRequest::post()
        .uri("/api/auth/google/start")
        .insert_header(("Origin", "http://localhost"))
        .insert_header(("X-CSRF-Token", CSRF))
        .cookie(Cookie::new("deskfleet_csrf", CSRF))
        .set_json(json!({"returnTo":return_to,"acceptedTerms":accepted_terms}))
}

struct Attempt {
    binding: Cookie<'static>,
    query: HashMap<String, String>,
}

impl Attempt {
    async fn from_response(response: ServiceResponse) -> Self {
        assert_eq!(response.status(), StatusCode::OK);
        let binding = response
            .response()
            .cookies()
            .find(|cookie| cookie.name() == "deskfleet_google_state")
            .unwrap()
            .into_owned();
        assert_eq!(binding.http_only(), Some(true));
        let body: Value = test::read_body_json(response).await;
        let url = url::Url::parse(body["authorizationUrl"].as_str().unwrap()).unwrap();
        assert_eq!(
            url.origin().ascii_serialization(),
            "https://accounts.google.com"
        );
        let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["state"], binding.value());
        assert_eq!(query["client_id"], "google-client");
        assert_eq!(query["redirect_uri"], CALLBACK);
        assert_eq!(query["scope"], "openid email profile");
        assert_eq!(query["response_type"], "code");
        assert_eq!(query["code_challenge_method"], "S256");
        Self { binding, query }
    }

    fn callback(&self, code: &str) -> test::TestRequest {
        test::TestRequest::get()
            .uri(&format!(
                "/api/auth/google/callback?state={}&code={code}",
                self.binding.value()
            ))
            .cookie(self.binding.clone())
    }
}

fn assert_redirect_error(response: &ServiceResponse, code: &str) {
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(
        response
            .headers()
            .get("Location")
            .unwrap()
            .to_str()
            .unwrap(),
        format!("http://localhost/auth/login?googleError={code}")
    );
    assert!(
        response
            .response()
            .cookies()
            .all(|cookie| cookie.name() != "deskfleet_session")
    );
}

#[actix_web::test]
#[ignore = "requires real PostgreSQL TEST_DATABASE_URL"]
async fn google_callback_binds_browser_provider_pkce_and_continuation() {
    let fixture = Fixture::new().await;
    let app = test::init_service(
        App::new()
            .app_data(fixture.state.clone())
            .configure(configure),
    )
    .await;
    let config: Value = test::call_and_read_body_json(
        &app,
        test::TestRequest::get()
            .uri("/api/auth/config")
            .to_request(),
    )
    .await;
    assert_eq!(config["googleEnabled"], true);
    assert_eq!(config["githubEnabled"], true);

    let csrf_missing = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/auth/google/start")
            .insert_header(("Origin", "http://localhost"))
            .set_json(json!({"returnTo":"/auth/login"}))
            .to_request(),
    )
    .await;
    assert_eq!(csrf_missing.status(), StatusCode::FORBIDDEN);
    let origin_wrong = test::call_service(
        &app,
        start("/auth/login", true)
            .insert_header(("Origin", "https://attacker.example"))
            .to_request(),
    )
    .await;
    assert_eq!(origin_wrong.status(), StatusCode::FORBIDDEN);
    let invalid = test::call_service(&app, start("//attacker.example", true).to_request()).await;
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

    let attempt = Attempt::from_response(
        test::call_service(&app, start("/auth/login", true).to_request()).await,
    )
    .await;
    let callback = format!(
        "/api/auth/google/callback?state={}&code=success",
        attempt.binding.value()
    );
    let missing_state = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/auth/google/callback?code=success")
            .cookie(attempt.binding.clone())
            .to_request(),
    )
    .await;
    assert_eq!(missing_state.status(), StatusCode::UNAUTHORIZED);
    let unbound =
        test::call_service(&app, test::TestRequest::get().uri(&callback).to_request()).await;
    assert_eq!(unbound.status(), StatusCode::UNAUTHORIZED);
    let wrong_binding = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&callback)
            .cookie(Cookie::new("deskfleet_google_state", "wrong-browser"))
            .to_request(),
    )
    .await;
    assert_eq!(wrong_binding.status(), StatusCode::UNAUTHORIZED);
    assert!(fixture.exchanges.lock().unwrap().is_empty());
    let denied = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&format!(
                "/api/auth/google/callback?state={}&error=access_denied",
                attempt.binding.value()
            ))
            .cookie(attempt.binding.clone())
            .to_request(),
    )
    .await;
    assert_redirect_error(&denied, "failed");
    let replay = test::call_service(&app, attempt.callback("success").to_request()).await;
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);

    // A valid attempt from another provider must not enter Google's code exchange.
    let github = test::call_service(
        &app,
        start("/auth/login", true)
            .uri("/api/auth/github/start")
            .to_request(),
    )
    .await;
    let github_binding = github
        .response()
        .cookies()
        .find(|cookie| cookie.name() == "deskfleet_github_state")
        .unwrap()
        .into_owned();
    let mixed = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&format!(
                "/api/auth/google/callback?state={}&code=success",
                github_binding.value()
            ))
            .cookie(Cookie::new(
                "deskfleet_google_state",
                github_binding.value().to_owned(),
            ))
            .to_request(),
    )
    .await;
    assert_eq!(mixed.status(), StatusCode::UNAUTHORIZED);
    assert!(fixture.exchanges.lock().unwrap().is_empty());

    let mut session = None;
    for path in ["/auth/desktop?attempt=native-attempt", "/auth/email/verify"] {
        let attempt =
            Attempt::from_response(test::call_service(&app, start(path, true).to_request()).await)
                .await;
        let success = test::call_service(&app, attempt.callback("success").to_request()).await;
        assert_eq!(success.status(), StatusCode::FOUND);
        assert_eq!(
            success.headers().get("Location").unwrap().to_str().unwrap(),
            format!("http://localhost{path}")
        );
        assert_eq!(success.headers().get("Cache-Control").unwrap(), "no-store");
        assert_eq!(
            success.headers().get("Referrer-Policy").unwrap(),
            "no-referrer"
        );
        let cookie = success
            .response()
            .cookies()
            .find(|cookie| cookie.name() == "deskfleet_session")
            .unwrap()
            .into_owned();
        assert_eq!(cookie.http_only(), Some(true));
        session = Some(cookie);
        let exchanges = fixture.exchanges.lock().unwrap();
        let verifier = &exchanges.last().unwrap()["code_verifier"];
        assert_eq!(
            attempt.query["code_challenge"],
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
        );
    }
    let session = session.unwrap();
    let me: Value = test::call_and_read_body_json(
        &app,
        test::TestRequest::get()
            .uri("/api/me")
            .cookie(session.clone())
            .to_request(),
    )
    .await;
    assert_eq!(me["user"]["name"], "Google User");
    assert_eq!(me["user"]["email"], "google@example.test");
    let signed_in = test::call_service(
        &app,
        start("/auth/login", true)
            .cookie(session.clone())
            .to_request(),
    )
    .await;
    assert_eq!(signed_in.status(), StatusCode::FORBIDDEN);
    let attempt = Attempt::from_response(
        test::call_service(&app, start("/auth/login", true).to_request()).await,
    )
    .await;
    let signed_in_callback = test::call_service(
        &app,
        attempt.callback("success").cookie(session).to_request(),
    )
    .await;
    assert_eq!(signed_in_callback.status(), StatusCode::FORBIDDEN);
    assert_eq!(fixture.exchanges.lock().unwrap().len(), 2);
    fixture.finish().await;
}

#[actix_web::test]
#[ignore = "requires real PostgreSQL TEST_DATABASE_URL"]
async fn google_registration_and_reauthentication_enforce_current_policy() {
    let fixture = Fixture::new().await;
    let app = test::init_service(
        App::new()
            .app_data(fixture.state.clone())
            .configure(configure),
    )
    .await;
    fixture
        .state
        .store
        .verified_user("existing@example.test", "Existing")
        .await
        .unwrap();
    for (code, error) in [
        ("token-error", "failed"),
        ("userinfo-error", "failed"),
        ("unverified", "failed"),
        ("missing-email", "failed"),
        ("missing-verification", "failed"),
        ("empty-subject", "failed"),
        ("email-conflict", "email_conflict"),
    ] {
        let attempt = Attempt::from_response(
            test::call_service(&app, start("/auth/login", true).to_request()).await,
        )
        .await;
        let response = test::call_service(&app, attempt.callback(code).to_request()).await;
        assert_redirect_error(&response, error);
    }
    assert!(matches!(
        fixture.state.store.google_account("google-user").await,
        Err(deskfleet_control_store::Error::NotFound)
    ));

    let attempt = Attempt::from_response(
        test::call_service(&app, start("/auth/login", false).to_request()).await,
    )
    .await;
    fixture.sql("UPDATE cp_site_settings SET privacy_terms_url='https://example.test/privacy' WHERE singleton").await;
    let missing_consent = test::call_service(&app, start("/auth/login", false).to_request()).await;
    assert_eq!(missing_consent.status(), StatusCode::BAD_REQUEST);
    let changed_consent = test::call_service(&app, attempt.callback("success").to_request()).await;
    assert_redirect_error(&changed_consent, "terms_required");
    let attempt = Attempt::from_response(
        test::call_service(&app, start("/auth/login", true).to_request()).await,
    )
    .await;
    let created = test::call_service(&app, attempt.callback("success").to_request()).await;
    assert_eq!(created.status(), StatusCode::FOUND);
    assert_eq!(
        created.headers().get("Location").unwrap(),
        "http://localhost/auth/login"
    );
    let user = fixture
        .state
        .store
        .google_account("google-user")
        .await
        .unwrap();

    fixture.sql("UPDATE cp_site_settings SET privacy_terms_url='' WHERE singleton; UPDATE cp_registration_policy SET enabled=FALSE").await;
    let attempt = Attempt::from_response(
        test::call_service(&app, start("/auth/login", false).to_request()).await,
    )
    .await;
    let blocked_registration =
        test::call_service(&app, attempt.callback("new-user").to_request()).await;
    assert_redirect_error(&blocked_registration, "registration_disabled");
    let attempt = Attempt::from_response(
        test::call_service(&app, start("/auth/login", false).to_request()).await,
    )
    .await;
    let established =
        test::call_service(&app, attempt.callback("existing-no-email").to_request()).await;
    assert_eq!(established.status(), StatusCode::FOUND);
    assert_eq!(
        established.headers().get("Location").unwrap(),
        "http://localhost/auth/login"
    );
    assert!(
        established
            .response()
            .cookies()
            .any(|cookie| cookie.name() == "deskfleet_session")
    );

    let attempt = Attempt::from_response(
        test::call_service(&app, start("/auth/login", true).to_request()).await,
    )
    .await;
    fixture
        .state
        .store
        .revoke_user_sessions(&user.id, None)
        .await
        .unwrap();
    let revoked = test::call_service(&app, attempt.callback("success").to_request()).await;
    assert_redirect_error(&revoked, "failed");
    let fresh = Attempt::from_response(
        test::call_service(&app, start("/auth/login", true).to_request()).await,
    )
    .await;
    let signed_in = test::call_service(&app, fresh.callback("success").to_request()).await;
    assert_eq!(signed_in.status(), StatusCode::FOUND);
    assert!(
        signed_in
            .response()
            .cookies()
            .any(|cookie| cookie.name() == "deskfleet_session")
    );
    fixture.finish().await;
}

#[actix_web::test]
#[ignore = "requires real PostgreSQL TEST_DATABASE_URL"]
async fn passwordless_reauthentication_preserves_session_and_rejects_other_accounts() {
    let fixture = Fixture::new().await;
    let app = test::init_service(
        App::new()
            .app_data(fixture.state.clone())
            .configure(configure),
    )
    .await;
    let user = fixture
        .state
        .store
        .google_user("google-user", "google@example.test", "Google", false)
        .await
        .unwrap();
    let session = fixture.state.store.new_session(&user.id).await.unwrap();
    let cookie = Cookie::new(
        "deskfleet_session",
        session["token"].as_str().unwrap().to_owned(),
    );
    let id = session["sessionId"].as_str().unwrap();
    fixture
        .sql("UPDATE cp_login_sessions SET authenticated_at=0")
        .await;
    let methods: Value = test::call_and_read_body_json(
        &app,
        test::TestRequest::get()
            .uri("/api/auth/reauthenticate/methods")
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(
        methods,
        json!({"password":false,"passkey":false,"github":false,"google":true})
    );
    fixture
        .state
        .store
        .google_user("email-conflict", "existing@example.test", "Other", false)
        .await
        .unwrap();
    fixture
        .state
        .store
        .save_login_attempt(
            "native",
            json!({
                "returnTo":"http://127.0.0.1:19091/auth/callback",
                "loginVerifierHash": deskfleet_control_store::secret_hash("native-verifier"),
            }),
        )
        .await
        .unwrap();
    let sensitive = |path: &str| {
        test::TestRequest::post()
            .uri(path)
            .insert_header(("Origin", "http://localhost"))
            .insert_header(("X-CSRF-Token", CSRF))
            .cookie(Cookie::new("deskfleet_csrf", CSRF))
            .cookie(cookie.clone())
            .set_json(json!({"attempt":"native"}))
            .to_request()
    };
    for path in [
        "/api/auth/passkeys/register/options",
        "/api/auth/desktop/complete",
    ] {
        let response = test::call_service(&app, sensitive(path)).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body: Value = test::read_body_json(response).await;
        assert_eq!(body["error"]["code"], "recent_authentication_required");
    }
    // Reauthentication is independent of signup terms and registration policy.
    fixture.sql("UPDATE cp_site_settings SET privacy_terms_url='https://example.test/privacy'; UPDATE cp_registration_policy SET enabled=FALSE").await;
    for code in ["email-conflict", "new-user", "success"] {
        let attempt = Attempt::from_response(
            test::call_service(
                &app,
                start("/auth/desktop?attempt=native", false)
                    .cookie(cookie.clone())
                    .set_json(
                        json!({"returnTo":"/auth/desktop?attempt=native","reauthenticate":true}),
                    )
                    .to_request(),
            )
            .await,
        )
        .await;
        let response = test::call_service(
            &app,
            attempt.callback(code).cookie(cookie.clone()).to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FOUND);
        assert!(
            response
                .response()
                .cookies()
                .all(|c| c.name() != "deskfleet_session")
        );
        assert_eq!(
            fixture.state.store.recent_authentication(id).await.unwrap(),
            code == "success"
        );
        assert_eq!(
            response.headers().get("Location").unwrap(),
            if code == "success" {
                "http://localhost/auth/desktop?attempt=native"
            } else {
                "http://localhost/auth/desktop?attempt=native&googleError=failed"
            }
        );
        let replay = test::call_service(
            &app,
            attempt.callback(code).cookie(cookie.clone()).to_request(),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    }
    // The callback really unlocks both protected endpoints using the original cookie.
    let options = test::call_service(&app, sensitive("/api/auth/passkeys/register/options")).await;
    assert_eq!(options.status(), StatusCode::OK);
    let options: Value = test::read_body_json(options).await;
    assert!(options["publicKey"]["challenge"].is_string());
    let desktop = test::call_service(&app, sensitive("/api/auth/desktop/complete")).await;
    assert_eq!(desktop.status(), StatusCode::OK);
    let desktop: Value = test::read_body_json(desktop).await;
    let redirect = url::Url::parse(desktop["returnTo"].as_str().unwrap()).unwrap();
    let code = redirect
        .fragment()
        .unwrap()
        .strip_prefix("loginCode=")
        .unwrap();
    let exchange = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/auth/exchange")
            .set_json(json!({"code":code,"loginVerifier":"native-verifier"}))
            .to_request(),
    )
    .await;
    assert_eq!(exchange.status(), StatusCode::OK);
    let exchange: Value = test::read_body_json(exchange).await;
    assert_eq!(exchange["user"]["id"], user.id);
    assert!(matches!(
        fixture.state.store.google_account("new-user").await,
        Err(deskfleet_control_store::Error::NotFound)
    ));
    fixture
        .sql("UPDATE cp_login_sessions SET authenticated_at=0")
        .await;
    let attempt = Attempt::from_response(
        test::call_service(
            &app,
            start("/", false)
                .cookie(cookie.clone())
                .set_json(json!({"returnTo":"/","reauthenticate":true}))
                .to_request(),
        )
        .await,
    )
    .await;
    let other = fixture.state.store.new_session(&user.id).await.unwrap();
    let response = test::call_service(
        &app,
        attempt
            .callback("success")
            .cookie(Cookie::new(
                "deskfleet_session",
                other["token"].as_str().unwrap().to_owned(),
            ))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(!fixture.state.store.recent_authentication(id).await.unwrap());
    let attempt = Attempt::from_response(
        test::call_service(
            &app,
            start("/", false)
                .cookie(cookie.clone())
                .set_json(json!({"returnTo":"/","reauthenticate":true}))
                .to_request(),
        )
        .await,
    )
    .await;
    fixture.state.store.logout(id).await.unwrap();
    let response = test::call_service(
        &app,
        attempt.callback("success").cookie(cookie).to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    fixture.finish().await;
}
