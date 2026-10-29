//! Configured legal links gate registration before a challenge or email is issued.
use actix_web::{App, cookie::Cookie, http::StatusCode, test, web};
use deskfleet_server::{
    AppState,
    auth::config::{AuthConfig, MailConfig},
    config::ServerConfig,
    configure,
};
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
use serde_json::{Value, json};

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn registration_requires_consent_for_either_configured_terms_link() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let database = Database::connect(&url).await.unwrap();
    let schema = format!("terms_http_{}", uuid::Uuid::new_v4().simple());
    database
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let directory = std::env::temp_dir().join(&schema);
    std::fs::create_dir(&directory).unwrap();
    let mut auth = AuthConfig::development("http://localhost");
    auth.mail = MailConfig::Local {
        directory: directory.clone(),
    };
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: format!("{url}{separator}options=-csearch_path%3D{schema}"),
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
    let admin = state
        .store
        .verified_user("admin@terms.test", "Admin")
        .await
        .unwrap();
    state.store.grant_site_admin(&admin.id).await.unwrap();
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;
    let mut settings = state.store.site_settings().await.unwrap();
    let mut delivered = 0;
    for (terms, privacy) in [
        ("https://example.test/terms", "https://example.test/privacy"),
        ("https://example.test/terms", ""),
        ("", "https://example.test/privacy"),
        ("", ""),
    ] {
        settings.terms_of_service_url = terms.into();
        settings.privacy_terms_url = privacy.into();
        state
            .store
            .update_site_settings(&admin.id, &settings)
            .await
            .unwrap();
        let config: Value = test::call_and_read_body_json(
            &app,
            test::TestRequest::get()
                .uri("/api/auth/config")
                .to_request(),
        )
        .await;
        assert_eq!(config["termsOfServiceUrl"], terms);
        assert_eq!(config["privacyTermsUrl"], privacy);
        let csrf = config["csrfToken"].as_str().unwrap();
        let email = format!("new-{}@terms.test", uuid::Uuid::new_v4());
        let registration = |body: Value| {
            test::TestRequest::post()
                .uri("/api/auth/register")
                .insert_header(("Origin", "http://localhost"))
                .insert_header(("X-CSRF-Token", csrf))
                .cookie(Cookie::new("deskfleet_csrf", csrf.to_owned()))
                .set_json(body)
                .to_request()
        };
        let required = !terms.is_empty() || !privacy.is_empty();
        if required {
            for body in [
                json!({"email":email}),
                json!({"email":email,"acceptedTerms":false}),
            ] {
                let response = test::call_service(&app, registration(body)).await;
                assert_eq!(response.status(), StatusCode::BAD_REQUEST);
                let error: Value = test::read_body_json(response).await;
                assert_eq!(error["error"]["code"], "terms_acceptance_required");
            }
            let challenge = state
                .store
                .database()
                .query_one_raw(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "SELECT token_hash FROM cp_identity_challenges WHERE email=$1",
                    vec![email.clone().into()],
                ))
                .await
                .unwrap();
            assert!(
                challenge.is_none(),
                "rejected consent must not issue a challenge"
            );
            assert_eq!(std::fs::read_dir(&directory).unwrap().count(), delivered);
        }
        let body = if required {
            json!({"email":email,"acceptedTerms":true})
        } else {
            json!({"email":email})
        };
        let response = test::call_service(&app, registration(body)).await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        delivered += 1;
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), delivered);

        // Recovery still accepts its original email-only payload, regardless of terms settings.
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/auth/recovery")
                .insert_header(("Origin", "http://localhost"))
                .insert_header(("X-CSRF-Token", csrf))
                .cookie(Cookie::new("deskfleet_csrf", csrf.to_owned()))
                .set_json(json!({"email":email}))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }
    state.store.close().await.unwrap();
    database
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    database.close().await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}
