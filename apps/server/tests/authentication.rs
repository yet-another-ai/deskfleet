//! Real PostgreSQL identity invariants and browser/desktop HTTP contracts.
use actix_web::{
    App,
    cookie::Cookie,
    http::{Method, StatusCode},
    test, web,
};
use deskfleet_server::{
    AppState,
    auth::config::{AuthConfig, MailConfig},
    config::ServerConfig,
    configure,
};
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::{Value, json};

#[path = "support/passkey_privacy.rs"]
mod passkey_privacy;
#[path = "support/resident_passkey.rs"]
mod resident_passkey;

fn request(method: Method, path: &str, csrf: &str, session: Option<&str>) -> test::TestRequest {
    let request = test::TestRequest::default()
        .method(method)
        .uri(path)
        .insert_header(("Origin", "http://localhost"))
        .insert_header(("X-CSRF-Token", csrf))
        .cookie(Cookie::new("deskfleet_csrf", csrf.to_owned()));
    if let Some(session) = session {
        request.cookie(Cookie::new("deskfleet_session", session.to_owned()))
    } else {
        request
    }
}
fn mail_token(directory: &std::path::Path, subject: &str) -> String {
    let mail = std::fs::read_dir(directory)
        .unwrap()
        .filter_map(|entry| std::fs::read_to_string(entry.ok()?.path()).ok())
        .find(|mail| mail.contains(subject))
        .expect("mail delivered to local sink");
    let decoded = mail
        .replace("=3D", "=")
        .replace("=\r\n", "")
        .replace("=\n", "");
    decoded
        .split("#token=")
        .nth(1)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned()
}
#[actix_web::test]
#[ignore = "requires real PostgreSQL TEST_DATABASE_URL"]
async fn mailbox_proof_cookies_csrf_recovery_desktop_and_disable() {
    let database_url = std::env::var("TEST_DATABASE_URL").unwrap();
    let directory =
        std::env::temp_dir().join(format!("deskfleet-auth-test-{}", uuid::Uuid::new_v4()));
    let mut auth = AuthConfig::development("http://localhost");
    auth.mail = MailConfig::Local {
        directory: directory.clone(),
    };
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url,
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
    let config: Value = test::call_and_read_body_json(
        &app,
        test::TestRequest::get()
            .uri("/api/auth/config")
            .to_request(),
    )
    .await;
    let csrf = config["csrfToken"].as_str().unwrap();
    let email = format!("owned-{}@example.test", uuid::Uuid::new_v4());
    let response = test::call_service(
        &app,
        request(Method::POST, "/api/auth/register", csrf, None)
            .set_json(json!({"email":email}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert!(
        state
            .store
            .password_credentials(&email)
            .await
            .unwrap()
            .is_none(),
        "registration does not attach any unverified credential"
    );
    let token = mail_token(&directory, "Verify your DeskFleet email");
    let response=test::call_service(&app,request(Method::POST,"/api/auth/verify",csrf,None).set_json(json!({"token":token,"name":"Verified owner","password":"A distinctive initial password 738"})).to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let session_cookie = response
        .response()
        .cookies()
        .find(|c| c.name() == "deskfleet_session")
        .unwrap();
    assert_eq!(session_cookie.http_only(), Some(true));
    assert_eq!(
        session_cookie.same_site(),
        Some(actix_web::cookie::SameSite::Lax)
    );
    let session = session_cookie.value().to_owned();
    let body: Value = test::read_body_json(response).await;
    assert!(body.get("token").is_none());
    let user_id = body["user"]["id"].as_str().unwrap().to_owned();
    let csrf = body["csrfToken"].as_str().unwrap().to_owned();
    let credentials = state
        .store
        .password_credentials(&email)
        .await
        .unwrap()
        .unwrap();
    assert!(
        credentials["passwordHash"]
            .as_str()
            .unwrap()
            .starts_with("$argon2id$")
    );
    let replay=test::call_service(&app,request(Method::POST,"/api/auth/verify",&csrf,None).set_json(json!({"token":token,"name":"Intruder","password":"A distinctive attacker password 738"})).to_request()).await;
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    let missing_csrf = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/teams")
            .cookie(Cookie::new("deskfleet_session", session.clone()))
            .set_json(json!({"name":"Forbidden"}))
            .to_request(),
    )
    .await;
    assert_eq!(missing_csrf.status(), StatusCode::FORBIDDEN);
    let evil_origin = test::call_service(
        &app,
        request(Method::POST, "/api/teams", &csrf, Some(&session))
            .insert_header(("Origin", "https://evil.test"))
            .set_json(json!({"name":"Forbidden"}))
            .to_request(),
    )
    .await;
    assert_eq!(evil_origin.status(), StatusCode::FORBIDDEN);
    let sessions: Value = test::call_and_read_body_json(
        &app,
        request(Method::GET, "/api/auth/sessions", &csrf, Some(&session)).to_request(),
    )
    .await;
    assert_eq!(sessions.as_array().unwrap().len(), 1);
    // Exercise real WebAuthn signatures with a software authenticator. Its
    // test-only UV flag stands in for successful platform user verification.
    let mut authenticator = resident_passkey::ResidentPasskey::new();
    let options: Value = test::call_and_read_body_json(
        &app,
        request(
            Method::POST,
            "/api/auth/passkeys/register/options",
            &csrf,
            Some(&session),
        )
        .to_request(),
    )
    .await;
    let credential = authenticator
        .do_registration(
            url::Url::parse("http://localhost").unwrap(),
            serde_json::from_value(json!({"publicKey":options["publicKey"]})).unwrap(),
        )
        .unwrap();
    let registered=test::call_service(&app,request(Method::POST,"/api/auth/passkeys/register",&csrf,Some(&session)).set_json(json!({"ceremonyId":options["ceremonyId"],"credential":credential,"name":"Software test passkey"})).to_request()).await;
    assert_eq!(registered.status(), StatusCode::CREATED);
    let replay = test::call_service(
        &app,
        request(
            Method::POST,
            "/api/auth/passkeys/register",
            &csrf,
            Some(&session),
        )
        .set_json(
            json!({"ceremonyId":options["ceremonyId"],"credential":credential,"name":"Replay"}),
        )
        .to_request(),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    let options: Value = test::call_and_read_body_json(
        &app,
        request(
            Method::POST,
            "/api/auth/passkeys/login/options",
            &csrf,
            None,
        )
        .set_json(json!({"email":email}))
        .to_request(),
    )
    .await;
    let credential = authenticator
        .do_authentication(
            url::Url::parse("http://localhost:9999").unwrap(),
            serde_json::from_value(json!({"publicKey":options["publicKey"]})).unwrap(),
        )
        .unwrap();
    let wrong_origin = test::call_service(
        &app,
        request(Method::POST, "/api/auth/passkeys/login", &csrf, None)
            .set_json(json!({"ceremonyId":options["ceremonyId"],"credential":credential}))
            .to_request(),
    )
    .await;
    assert_eq!(wrong_origin.status(), StatusCode::UNAUTHORIZED);
    let options: Value = test::call_and_read_body_json(
        &app,
        request(
            Method::POST,
            "/api/auth/passkeys/login/options",
            &csrf,
            None,
        )
        .set_json(json!({"email":email}))
        .to_request(),
    )
    .await;
    let credential = authenticator
        .do_authentication(
            url::Url::parse("http://localhost").unwrap(),
            serde_json::from_value(json!({"publicKey":options["publicKey"]})).unwrap(),
        )
        .unwrap();
    let passkey_login = test::call_service(
        &app,
        request(Method::POST, "/api/auth/passkeys/login", &csrf, None)
            .set_json(json!({"ceremonyId":options["ceremonyId"],"credential":credential}))
            .to_request(),
    )
    .await;
    assert_eq!(passkey_login.status(), StatusCode::OK);
    let replay = test::call_service(
        &app,
        request(Method::POST, "/api/auth/passkeys/login", &csrf, None)
            .set_json(json!({"ceremonyId":options["ceremonyId"],"credential":credential}))
            .to_request(),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    // Existing browser flow still creates a proof-bound native credential.
    let start: Value = test::call_and_read_body_json(
        &app,
        test::TestRequest::post()
            .uri("/api/auth/start")
            .set_json(json!({"returnTo":"http://127.0.0.1:41837/auth/callback"}))
            .to_request(),
    )
    .await;
    let url = url::Url::parse(start["authorizationUrl"].as_str().unwrap()).unwrap();
    let attempt = url
        .query_pairs()
        .find(|(key, _)| key == "attempt")
        .unwrap()
        .1
        .to_string();
    let complete: Value = test::call_and_read_body_json(
        &app,
        request(
            Method::POST,
            "/api/auth/desktop/complete",
            &csrf,
            Some(&session),
        )
        .set_json(json!({"attempt":attempt}))
        .to_request(),
    )
    .await;
    let callback = url::Url::parse(complete["returnTo"].as_str().unwrap()).unwrap();
    let code = callback
        .fragment()
        .unwrap()
        .strip_prefix("loginCode=")
        .unwrap();
    let wrong = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/auth/exchange")
            .set_json(json!({"code":code,"loginVerifier":"wrong"}))
            .to_request(),
    )
    .await;
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    let native: Value = test::call_and_read_body_json(
        &app,
        test::TestRequest::post()
            .uri("/api/auth/exchange")
            .set_json(json!({"code":code,"loginVerifier":start["loginVerifier"]}))
            .to_request(),
    )
    .await;
    assert!(
        state
            .store
            .authenticate(native["token"].as_str().unwrap())
            .await
            .is_ok()
    );
    let replay = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/auth/exchange")
            .set_json(json!({"code":code,"loginVerifier":start["loginVerifier"]}))
            .to_request(),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    // Recovery is purpose-bound and revokes both browser and native sessions.
    let unknown = test::call_service(
        &app,
        request(Method::POST, "/api/auth/recovery", &csrf, None)
            .set_json(json!({"email":"absent@example.test"}))
            .to_request(),
    )
    .await;
    let known = test::call_service(
        &app,
        request(Method::POST, "/api/auth/recovery", &csrf, None)
            .set_json(json!({"email":email}))
            .to_request(),
    )
    .await;
    assert_eq!(unknown.status(), known.status());
    assert_eq!(known.status(), StatusCode::ACCEPTED);
    let reset = mail_token(&directory, "Reset your DeskFleet password");
    let result = test::call_service(
        &app,
        request(Method::POST, "/api/auth/recovery/complete", &csrf, None)
            .set_json(json!({"token":reset,"password":"A replacement secret password 902"}))
            .to_request(),
    )
    .await;
    assert_eq!(result.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        state.store.passkeys(&user_id).await.unwrap().len(),
        1,
        "ordinary password recovery retains Passkeys"
    );
    assert!(state.store.authenticate(&session).await.is_err());
    assert!(
        state
            .store
            .authenticate(native["token"].as_str().unwrap())
            .await
            .is_err()
    );
    let replay = test::call_service(
        &app,
        request(Method::POST, "/api/auth/recovery/complete", &csrf, None)
            .set_json(json!({"token":reset,"password":"Another replacement password 901"}))
            .to_request(),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    let login = test::call_service(
        &app,
        request(Method::POST, "/api/auth/login", &csrf, None)
            .set_json(json!({"email":email,"password":"A replacement secret password 902"}))
            .to_request(),
    )
    .await;
    assert_eq!(login.status(), StatusCode::OK);
    let fresh = login
        .response()
        .cookies()
        .find(|c| c.name() == "deskfleet_session")
        .unwrap()
        .value()
        .to_owned();
    // Changing email proves the new mailbox, preserves the user ID, and revokes sessions.
    let new_email = format!("changed-{}@example.test", uuid::Uuid::new_v4());
    let change = test::call_service(
        &app,
        request(Method::POST, "/api/auth/email", &csrf, Some(&fresh))
            .set_json(json!({"email":new_email}))
            .to_request(),
    )
    .await;
    assert_eq!(change.status(), StatusCode::ACCEPTED);
    assert_eq!(
        state
            .store
            .account(&user_id)
            .await
            .unwrap()
            .email
            .as_deref(),
        Some(email.as_str())
    );
    let proof = mail_token(&directory, "Verify your new DeskFleet email");
    let verified = test::call_service(
        &app,
        request(Method::POST, "/api/auth/email/verify", &csrf, Some(&fresh))
            .set_json(json!({"token":proof}))
            .to_request(),
    )
    .await;
    assert_eq!(verified.status(), StatusCode::NO_CONTENT);
    assert!(state.store.authenticate(&fresh).await.is_err());
    assert_eq!(
        state
            .store
            .account(&user_id)
            .await
            .unwrap()
            .email
            .as_deref(),
        Some(new_email.as_str())
    );
    assert!(
        state
            .store
            .password_credentials(&email)
            .await
            .unwrap()
            .is_none()
    );
    let login = test::call_service(
        &app,
        request(Method::POST, "/api/auth/login", &csrf, None)
            .set_json(json!({"email":new_email,"password":"A replacement secret password 902"}))
            .to_request(),
    )
    .await;
    assert_eq!(login.status(), StatusCode::OK);
    let fresh = login
        .response()
        .cookies()
        .find(|c| c.name() == "deskfleet_session")
        .unwrap()
        .value()
        .to_owned();
    let changed = test::call_service(
        &app,
        request(Method::POST, "/api/auth/password", &csrf, Some(&fresh))
            .set_json(json!({"password":"Another deliberately chosen password 842"}))
            .to_request(),
    )
    .await;
    assert_eq!(changed.status(), StatusCode::NO_CONTENT);
    assert!(state.store.authenticate(&fresh).await.is_err());
    let login = test::call_service(
        &app,
        request(Method::POST, "/api/auth/login", &csrf, None)
            .set_json(
                json!({"email":new_email,"password":"Another deliberately chosen password 842"}),
            )
            .to_request(),
    )
    .await;
    assert_eq!(login.status(), StatusCode::OK);
    let fresh = login
        .response()
        .cookies()
        .find(|c| c.name() == "deskfleet_session")
        .unwrap()
        .value()
        .to_owned();
    // Revoking every session also invalidates a native approval not yet exchanged.
    let pending_code = state
        .store
        .new_login_code_for_session(
            &user_id,
            &state.store.authenticate(&fresh).await.unwrap().id,
            &deskfleet_control_store::secret_hash("pending-native-verifier"),
        )
        .await
        .unwrap();
    let revoked = test::call_service(
        &app,
        request(
            Method::POST,
            "/api/auth/sessions/revoke-all",
            &csrf,
            Some(&fresh),
        )
        .to_request(),
    )
    .await;
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
    assert!(
        state
            .store
            .exchange_login_code(&pending_code, "pending-native-verifier")
            .await
            .is_err()
    );
    let login = test::call_service(
        &app,
        request(Method::POST, "/api/auth/login", &csrf, None)
            .set_json(
                json!({"email":new_email,"password":"Another deliberately chosen password 842"}),
            )
            .to_request(),
    )
    .await;
    assert_eq!(login.status(), StatusCode::OK);
    let fresh = login
        .response()
        .cookies()
        .find(|c| c.name() == "deskfleet_session")
        .unwrap()
        .value()
        .to_owned();
    // Operator grant is explicit; account disable is persisted before denial.
    let admin = state
        .store
        .verified_user(
            &format!("admin-{}@example.test", uuid::Uuid::new_v4()),
            "Operator",
        )
        .await
        .unwrap();
    state.store.grant_site_admin(&admin.id).await.unwrap();
    let admin_session = state.store.new_session(&admin.id).await.unwrap();
    let team = state
        .store
        .create_team(&user_id, "Delegated work")
        .await
        .unwrap();
    let (machine, machine_token) = state
        .store
        .enroll(
            &user_id,
            &team.id,
            "Retained Machine",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    let delegated = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/daemon/authorize-delegation")
            .insert_header(("Authorization", format!("Bearer {machine_token}")))
            .set_json(json!({"userId":user_id}))
            .to_request(),
    )
    .await;
    assert_eq!(delegated.status(), StatusCode::OK);
    let disabled = test::call_service(
        &app,
        test::TestRequest::patch()
            .uri(&format!("/api/admin/users/{user_id}/disabled"))
            .insert_header((
                "Authorization",
                format!("Bearer {}", admin_session["token"].as_str().unwrap()),
            ))
            .set_json(json!({"disabled":true}))
            .to_request(),
    )
    .await;
    assert_eq!(disabled.status(), StatusCode::NO_CONTENT);
    assert!(state.store.authenticate(&fresh).await.is_err());
    assert!(state.store.new_session(&user_id).await.is_err());
    let delegated = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/daemon/authorize-delegation")
            .insert_header(("Authorization", format!("Bearer {machine_token}")))
            .set_json(json!({"userId":user_id}))
            .to_request(),
    )
    .await;
    assert_eq!(
        delegated.status(),
        StatusCode::FORBIDDEN,
        "disabled users cannot start later scheduled or delegated work"
    );
    assert_eq!(
        state
            .store
            .authenticate_machine(&machine_token)
            .await
            .unwrap()
            .machine
            .id,
        machine.id,
        "account disablement preserves independent Machine registration"
    );
    let registration = test::call_service(
        &app,
        test::TestRequest::patch()
            .uri("/api/auth/registration")
            .insert_header((
                "Authorization",
                format!("Bearer {}", admin_session["token"].as_str().unwrap()),
            ))
            .set_json(json!({"enabled":false}))
            .to_request(),
    )
    .await;
    assert_eq!(registration.status(), StatusCode::NO_CONTENT);
    let closed = test::call_service(
        &app,
        request(Method::POST, "/api/auth/register", &csrf, None)
            .set_json(json!({"email":"closed@example.test"}))
            .to_request(),
    )
    .await;
    assert_eq!(closed.status(), StatusCode::FORBIDDEN);
    state
        .store
        .set_registration_enabled(&admin.id, true)
        .await
        .unwrap();
    // Expired proofs do not grant identities even with a valid stored digest.
    let expired = state
        .store
        .issue_identity_challenge("registration", None, "expired@example.test", json!({}), -1)
        .await
        .unwrap();
    assert!(
        state
            .store
            .verify_registration(&expired, "Expired", "hash")
            .await
            .is_err()
    );
    // Recent authentication is enforced for credential management.
    state
        .store
        .database()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE cp_login_sessions SET authenticated_at=0 WHERE user_id=$1",
            [admin.id.into()],
        ))
        .await
        .unwrap();
    let stale = test::call_service(
        &app,
        test::TestRequest::patch()
            .uri("/api/auth/registration")
            .insert_header((
                "Authorization",
                format!("Bearer {}", admin_session["token"].as_str().unwrap()),
            ))
            .set_json(json!({"enabled":false}))
            .to_request(),
    )
    .await;
    assert_eq!(stale.status(), StatusCode::FORBIDDEN);
    std::fs::remove_dir_all(directory).unwrap();
}
