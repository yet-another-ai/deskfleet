//! Mailbox codes unlock only their initiating session and are bounded, one-use proofs.
use actix_web::{App, cookie::Cookie, http::StatusCode, test, web};
use deskfleet_server::{
    AppState,
    auth::config::{AuthConfig, MailConfig},
    config::ServerConfig,
    configure,
};
use sea_orm::{ConnectionTrait, Database};
use serde_json::{Value, json};

#[actix_web::test]
#[ignore = "requires real PostgreSQL TEST_DATABASE_URL"]
async fn email_codes_unlock_sensitive_actions_and_reject_reuse() {
    let database_url = std::env::var("TEST_DATABASE_URL").unwrap();
    let database = Database::connect(&database_url).await.unwrap();
    let schema = format!("email_auth_{}", uuid::Uuid::new_v4().simple());
    database
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if database_url.contains('?') { '&' } else { '?' };
    let directory = std::env::temp_dir().join(&schema);
    let mut auth = AuthConfig::development("http://localhost");
    auth.mail = MailConfig::Local {
        directory: directory.clone(),
    };
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: format!("{database_url}{separator}options=-csearch_path%3D{schema}"),
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
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;
    let user = state
        .store
        .google_user("email-user", "email@example.test", "Email User", false)
        .await
        .unwrap();
    let session = state.store.new_session(&user.id).await.unwrap();
    let id = session["sessionId"].as_str().unwrap();
    let token = session["token"].as_str().unwrap();
    let csrf = "email-reauthentication-csrf-32-characters";
    let post = |path: &str| {
        test::TestRequest::post()
            .uri(path)
            .insert_header(("Origin", "http://localhost"))
            .insert_header(("X-CSRF-Token", csrf))
            .cookie(Cookie::new("deskfleet_csrf", csrf))
            .cookie(Cookie::new("deskfleet_session", token.to_owned()))
    };
    state
        .store
        .database()
        .execute_unprepared("UPDATE cp_login_sessions SET authenticated_at=0")
        .await
        .unwrap();
    let blocked = test::call_service(
        &app,
        post("/api/auth/passkeys/register/options").to_request(),
    )
    .await;
    assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
    let csrf_missing = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/auth/reauthenticate/email")
            .cookie(Cookie::new("deskfleet_session", token.to_owned()))
            .to_request(),
    )
    .await;
    assert_eq!(csrf_missing.status(), StatusCode::FORBIDDEN);
    let sent = test::call_service(&app, post("/api/auth/reauthenticate/email").to_request()).await;
    assert_eq!(sent.status(), StatusCode::OK);
    let sent: Value = test::read_body_json(sent).await;
    assert!(sent.get("code").is_none());
    let challenge = sent["challengeId"].as_str().unwrap();
    let mail = std::fs::read_to_string(
        std::fs::read_dir(&directory)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path(),
    )
    .unwrap()
    .replace("=\r\n", "")
    .replace("=3D", "=");
    assert!(mail.contains("To: email@example.test"));
    let code = mail
        .split("code is: ")
        .nth(1)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap();
    assert_eq!(code.len(), 6);
    let resend =
        test::call_service(&app, post("/api/auth/reauthenticate/email").to_request()).await;
    assert_eq!(resend.status(), StatusCode::TOO_MANY_REQUESTS);
    let other = state.store.new_session(&user.id).await.unwrap();
    assert!(
        state
            .store
            .verify_email_authentication(
                &user.id,
                other["sessionId"].as_str().unwrap(),
                challenge,
                code
            )
            .await
            .is_err()
    );
    let wrong = if code == "000000" { "000001" } else { "000000" };
    let failed = test::call_service(
        &app,
        post("/api/auth/reauthenticate/email/verify")
            .set_json(json!({"challengeId":challenge,"code":wrong}))
            .to_request(),
    )
    .await;
    assert_eq!(failed.status(), StatusCode::BAD_REQUEST);
    assert!(!state.store.recent_authentication(id).await.unwrap());
    let verified = test::call_service(
        &app,
        post("/api/auth/reauthenticate/email/verify")
            .set_json(json!({"challengeId":challenge,"code":code}))
            .to_request(),
    )
    .await;
    assert_eq!(verified.status(), StatusCode::NO_CONTENT);
    let options = test::call_service(
        &app,
        post("/api/auth/passkeys/register/options").to_request(),
    )
    .await;
    assert_eq!(options.status(), StatusCode::OK);
    state.store.save_login_attempt("native", json!({"returnTo":"http://127.0.0.1:19091/auth/callback","loginVerifierHash":deskfleet_control_store::secret_hash("verifier")})).await.unwrap();
    let desktop = test::call_service(
        &app,
        post("/api/auth/desktop/complete")
            .set_json(json!({"attempt":"native"}))
            .to_request(),
    )
    .await;
    assert_eq!(desktop.status(), StatusCode::OK);
    let replay = test::call_service(
        &app,
        post("/api/auth/reauthenticate/email/verify")
            .set_json(json!({"challengeId":challenge,"code":code}))
            .to_request(),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::BAD_REQUEST);

    // Resending replaces the proof, and even concurrent valid submissions consume it once.
    let (old, old_code, _) = state
        .store
        .issue_email_authentication(&user.id, id)
        .await
        .unwrap();
    let (fresh, fresh_code, _) = state
        .store
        .issue_email_authentication(&user.id, id)
        .await
        .unwrap();
    assert!(
        state
            .store
            .verify_email_authentication(&user.id, id, &old, &old_code)
            .await
            .is_err()
    );
    let (first, second) = tokio::join!(
        state
            .store
            .verify_email_authentication(&user.id, id, &fresh, &fresh_code),
        state
            .store
            .verify_email_authentication(&user.id, id, &fresh, &fresh_code),
    );
    assert_ne!(first.is_ok(), second.is_ok());
    let (challenge, code, _) = state
        .store
        .issue_email_authentication(&user.id, id)
        .await
        .unwrap();
    let wrong = if code == "000000" { "000001" } else { "000000" };
    for _ in 0..5 {
        assert!(
            state
                .store
                .verify_email_authentication(&user.id, id, &challenge, wrong)
                .await
                .is_err()
        );
    }
    assert!(
        state
            .store
            .verify_email_authentication(&user.id, id, &challenge, &code)
            .await
            .is_err()
    );
    let (challenge, code, _) = state
        .store
        .issue_email_authentication(&user.id, id)
        .await
        .unwrap();
    state
        .store
        .database()
        .execute_unprepared("UPDATE cp_identity_challenges SET expires_at=0")
        .await
        .unwrap();
    assert!(
        state
            .store
            .verify_email_authentication(&user.id, id, &challenge, &code)
            .await
            .is_err()
    );
    let (challenge, code, _) = state
        .store
        .issue_email_authentication(&user.id, id)
        .await
        .unwrap();
    state
        .store
        .database()
        .execute_unprepared("UPDATE cp_users SET credential_version=credential_version+1")
        .await
        .unwrap();
    assert!(
        state
            .store
            .verify_email_authentication(&user.id, id, &challenge, &code)
            .await
            .is_err()
    );
    let (challenge, code, _) = state
        .store
        .issue_email_authentication(&user.id, id)
        .await
        .unwrap();
    state.store.logout(id).await.unwrap();
    assert!(
        state
            .store
            .verify_email_authentication(&user.id, id, &challenge, &code)
            .await
            .is_err()
    );
    std::fs::remove_dir_all(directory).unwrap();
    database
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    database.close().await.unwrap();
}
