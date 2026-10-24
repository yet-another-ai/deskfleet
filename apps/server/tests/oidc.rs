//! Real HTTP OIDC discovery/code exchange and PostgreSQL application sessions.
//! The committed RSA keys are public test fixtures, never deployment credentials.
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, http::StatusCode, test, web};
use base64::{Engine, engine::general_purpose::STANDARD};
use deskfleet_server::{
    AppState,
    config::{OidcConfig, ServerConfig},
    configure,
};
use openidconnect::{
    AccessToken, JsonWebKeyId, PkceCodeChallenge, PkceCodeVerifier, PrivateSigningKey,
    core::{CoreIdToken, CoreIdTokenClaims, CoreJwsSigningAlgorithm, CoreRsaPrivateSigningKey},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::TcpListener,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed},
    },
};

const CLIENT: &str = "rotation-test";
const CLIENT_SECRET: &str = "fixture-client-secret";
const CALLBACK: &str = "https://control.test/api/auth/callback";
const RETURN_TO: &str = "https://app.test/";

struct Provider {
    issuer: String,
    signing_key: AtomicUsize,
    published_key: AtomicUsize,
    fail_jwks: AtomicBool,
    bad_nonce: AtomicBool,
    discovery_requests: AtomicUsize,
    jwks_requests: AtomicUsize,
    token_requests: AtomicUsize,
    codes: Mutex<HashMap<String, HashMap<String, String>>>,
}

fn key(index: usize) -> CoreRsaPrivateSigningKey {
    let pem = [
        include_str!("fixtures/oidc-key-1.pem"),
        include_str!("fixtures/oidc-key-2.pem"),
    ][index];
    CoreRsaPrivateSigningKey::from_pem(pem, Some(JsonWebKeyId::new(format!("key-{index}"))))
        .unwrap()
}

async fn discovery(provider: web::Data<Provider>) -> web::Json<Value> {
    provider.discovery_requests.fetch_add(1, Relaxed);
    web::Json(json!({
        "issuer":provider.issuer,
        "authorization_endpoint":format!("{}/authorize", provider.issuer),
        "token_endpoint":format!("{}/token", provider.issuer),
        "jwks_uri":format!("{}/keys", provider.issuer),
        "response_types_supported":["code"],
        "subject_types_supported":["public"],
        "id_token_signing_alg_values_supported":["RS256"],
        "token_endpoint_auth_methods_supported":["client_secret_basic"],
        "code_challenge_methods_supported":["S256"]
    }))
}

async fn keys(provider: web::Data<Provider>) -> HttpResponse {
    provider.jwks_requests.fetch_add(1, Relaxed);
    if provider.fail_jwks.load(Relaxed) {
        return HttpResponse::ServiceUnavailable().finish();
    }
    HttpResponse::Ok().json(json!({
        "keys":[key(provider.published_key.load(Relaxed)).as_verification_key()]
    }))
}

async fn authorize(
    provider: web::Data<Provider>,
    query: web::Query<HashMap<String, String>>,
) -> HttpResponse {
    assert_eq!(query["client_id"], CLIENT);
    assert_eq!(query["redirect_uri"], CALLBACK);
    assert_eq!(query["response_type"], "code");
    assert_eq!(query["code_challenge_method"], "S256");
    let code = uuid::Uuid::new_v4().to_string();
    let mut redirect = url::Url::parse(CALLBACK).unwrap();
    redirect
        .query_pairs_mut()
        .append_pair("code", &code)
        .append_pair("state", &query["state"]);
    provider
        .codes
        .lock()
        .unwrap()
        .insert(code, query.into_inner());
    HttpResponse::Found()
        .insert_header(("Location", redirect.to_string()))
        .finish()
}

async fn token(
    req: HttpRequest,
    provider: web::Data<Provider>,
    form: web::Form<HashMap<String, String>>,
) -> HttpResponse {
    provider.token_requests.fetch_add(1, Relaxed);
    assert_eq!(
        req.headers()
            .get("Authorization")
            .unwrap()
            .to_str()
            .unwrap(),
        format!(
            "Basic {}",
            STANDARD.encode(format!("{CLIENT}:{CLIENT_SECRET}"))
        )
    );
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(form["redirect_uri"], CALLBACK);
    let auth = provider
        .codes
        .lock()
        .unwrap()
        .remove(&form["code"])
        .unwrap();
    let challenge = PkceCodeChallenge::from_code_verifier_sha256(&PkceCodeVerifier::new(
        form["code_verifier"].clone(),
    ));
    assert_eq!(challenge.as_str(), auth["code_challenge"]);
    let now = chrono::Utc::now().timestamp();
    let nonce = if provider.bad_nonce.load(Relaxed) {
        "incorrect-nonce"
    } else {
        &auth["nonce"]
    };
    let claims: CoreIdTokenClaims = serde_json::from_value(json!({
        "iss":provider.issuer, "aud":CLIENT, "sub":"fixture-user",
        "exp":now+300, "iat":now, "nonce":nonce,
        "email":"fixture@example.test", "email_verified":true, "name":"Fixture"
    }))
    .unwrap();
    let access = AccessToken::new("fixture-access".into());
    let token = CoreIdToken::new(
        claims,
        &key(provider.signing_key.load(Relaxed)),
        CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256,
        Some(&access),
        None,
    )
    .unwrap();
    HttpResponse::Ok().json(json!({
        "access_token":access.secret(), "token_type":"Bearer", "expires_in":300,
        "id_token":token
    }))
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn oidc_login_refreshes_rotated_keys_without_redeeming_the_code_twice() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let provider = web::Data::new(Provider {
        issuer: format!("http://{}", listener.local_addr().unwrap()),
        signing_key: AtomicUsize::new(0),
        published_key: AtomicUsize::new(0),
        fail_jwks: AtomicBool::new(false),
        bad_nonce: AtomicBool::new(false),
        discovery_requests: AtomicUsize::new(0),
        jwks_requests: AtomicUsize::new(0),
        token_requests: AtomicUsize::new(0),
        codes: Mutex::new(HashMap::new()),
    });
    let data = provider.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(data.clone())
            .route(
                "/.well-known/openid-configuration",
                web::get().to(discovery),
            )
            .route("/keys", web::get().to(keys))
            .route("/authorize", web::get().to(authorize))
            .route("/token", web::post().to(token))
    })
    .workers(1)
    .listen(listener)
    .unwrap()
    .run();
    let server_handle = server.handle();
    actix_web::rt::spawn(server);
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            database_url: std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL"),
            public_url: "https://control.test".into(),
            web_origins: vec![],
            oidc: Some(OidcConfig {
                issuer: provider.issuer.clone(),
                client_id: CLIENT.into(),
                client_secret: Some(CLIENT_SECRET.into()),
                callback_url: CALLBACK.into(),
                return_to: vec![RETURN_TO.into()],
            }),
            stun_urls: vec![],
            turn_urls: vec![],
            turn_secret: None,
        })
        .await
        .unwrap(),
    );
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    macro_rules! begin {
        () => {{
            let start: Value = test::call_and_read_body_json(&app,
                test::TestRequest::post().uri("/api/auth/start")
                    .set_json(json!({"returnTo":RETURN_TO})).to_request()).await;
            let redirect = http.get(start["authorizationUrl"].as_str().unwrap()).send().await.unwrap();
            assert_eq!(redirect.status(), reqwest::StatusCode::FOUND);
            let callback = url::Url::parse(redirect.headers()["Location"].to_str().unwrap()).unwrap();
            (format!("{}?{}", callback.path(), callback.query().unwrap()),
             start["loginVerifier"].as_str().unwrap().to_owned())
        }};
    }
    macro_rules! callback {
        ($login:expr) => {
            test::call_service(&app, test::TestRequest::get().uri(&$login.0).to_request())
        };
    }
    macro_rules! exchange {
        ($response:expr, $login:expr) => {{
            let response = $response;
            assert_eq!(response.status(), StatusCode::FOUND);
            let redirect = url::Url::parse(response.headers().get("Location").unwrap().to_str().unwrap()).unwrap();
            let code = redirect.fragment().unwrap().strip_prefix("loginCode=").unwrap();
            let session: Value = test::call_and_read_body_json(&app,
                test::TestRequest::post().uri("/api/auth/exchange")
                    .set_json(json!({"code":code,"loginVerifier":$login.1})).to_request()).await;
            let me: Value = test::call_and_read_body_json(&app,
                test::TestRequest::get().uri("/api/me")
                    .insert_header(("Authorization", format!("Bearer {}", session["token"].as_str().unwrap())))
                    .to_request()).await;
            me["user"]["id"].as_str().unwrap().to_owned()
        }};
    }
    let first = begin!();
    let user = exchange!(callback!(first).await, first);
    assert_eq!(provider.jwks_requests.load(Relaxed), 1);

    provider.signing_key.store(1, Relaxed);
    provider.published_key.store(1, Relaxed);
    let second = begin!();
    let third = begin!();
    let (second_response, third_response) = tokio::join!(callback!(second), callback!(third));
    assert_eq!(exchange!(second_response, second), user);
    assert_eq!(exchange!(third_response, third), user);
    assert_eq!(provider.jwks_requests.load(Relaxed), 2);
    let cached = begin!();
    assert_eq!(exchange!(callback!(cached).await, cached), user);
    assert_eq!(provider.jwks_requests.load(Relaxed), 2);

    // A refresh that still lacks the key must not accept an unverified token.
    provider.signing_key.store(0, Relaxed);
    let unknown = begin!();
    assert_eq!(callback!(unknown).await.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(provider.jwks_requests.load(Relaxed), 3);
    provider.fail_jwks.store(true, Relaxed);
    let unavailable = begin!();
    assert_eq!(
        callback!(unavailable).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(provider.jwks_requests.load(Relaxed), 4);

    // The successful refresh must still enforce nonce and the other OIDC claims.
    provider.fail_jwks.store(false, Relaxed);
    provider.published_key.store(0, Relaxed);
    provider.bad_nonce.store(true, Relaxed);
    let bad_nonce = begin!();
    assert_eq!(
        callback!(bad_nonce).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(provider.jwks_requests.load(Relaxed), 5);
    provider.bad_nonce.store(false, Relaxed);
    let recovered = begin!();
    assert_eq!(exchange!(callback!(recovered).await, recovered), user);
    assert_eq!(provider.jwks_requests.load(Relaxed), 5);
    assert_eq!(provider.discovery_requests.load(Relaxed), 1);
    assert_eq!(provider.token_requests.load(Relaxed), 8);
    state.store.close().await.unwrap();
    server_handle.stop(true).await;
}
