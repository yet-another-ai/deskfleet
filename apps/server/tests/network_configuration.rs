use actix_web::{App, http::StatusCode, test, web};
use deskfleet_server::{AppState, config::ServerConfig, configure};
use sea_orm::{ConnectionTrait, Database};
use serde_json::{Value, json};

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn network_configuration_requires_login_and_exposes_only_ordered_site_stun_urls() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let database = Database::connect(&url).await.unwrap();
    let schema = format!("network_http_{}", uuid::Uuid::new_v4().simple());
    database
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let configured = vec![
        "stun:primary.example.test:3478".to_owned(),
        "stuns:secure.example.test:5349".to_owned(),
        "stun:secondary.example.test:3478".to_owned(),
    ];
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: format!("{url}{separator}options=-csearch_path%3D{schema}"),
            public_url: "https://control.test".into(),
            web_origins: vec![],
            auth: deskfleet_server::auth::config::AuthConfig::development("https://control.test"),
            billing: Default::default(),
            github_app: None,
            stun_urls: configured.clone(),
            turn_urls: vec!["turn:relay.example.test:3478".into()],
            turn_secret: Some("not-for-diagnostics".into()),
            turn_usage_redis_url: None,
        })
        .await
        .unwrap(),
    );
    let user = state
        .store
        .verified_user(
            &format!("diagnostics-{}@fixture.test", uuid::Uuid::new_v4()),
            "Client user without a Team",
        )
        .await
        .unwrap();
    let login = state.store.new_session(&user.id).await.unwrap();
    let token = login["token"].as_str().unwrap();
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;

    for token in [None, Some("invalid-token")] {
        let request = test::TestRequest::get().uri("/api/network-configuration");
        let request = match token {
            Some(token) => request.insert_header(("Authorization", format!("Bearer {token}"))),
            None => request,
        };
        assert_eq!(
            test::call_service(&app, request.to_request())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/network-configuration")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body, json!({ "stunUrls": configured }));

    state.store.close().await.unwrap();
    database
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    database.close().await.unwrap();
}
