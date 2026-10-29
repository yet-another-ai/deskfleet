use actix_web::{App, http::StatusCode, test, web};
use serde_json::{Value, json};

use crate::{AppState, config::ServerConfig, configure};

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_http_ai_usage_requires_team_membership_and_valid_queries() {
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL"),
            public_url: "https://control.test".into(),
            web_origins: vec![],
            auth: crate::auth::config::AuthConfig::development("https://control.test"),
            billing: Default::default(),
            stun_urls: vec![],
            turn_urls: vec![],
            turn_secret: None,
            turn_usage_redis_url: None,
        })
        .await
        .unwrap(),
    );
    let suffix = uuid::Uuid::new_v4();
    let owner = state
        .store
        .verified_user(&format!("usage-api-{suffix}@fixture.test"), "Owner")
        .await
        .unwrap();
    let outsider = state
        .store
        .verified_user(&format!("usage-outside-{suffix}@fixture.test"), "Outside")
        .await
        .unwrap();
    let login = state.store.new_session(&owner.id).await.unwrap();
    let outside_login = state.store.new_session(&outsider.id).await.unwrap();
    let token = login["token"].as_str().unwrap();
    let outside_token = outside_login["token"].as_str().unwrap();
    let team = state
        .store
        .create_team(&owner.id, "Usage API fixture")
        .await
        .unwrap();
    let base = format!("/api/teams/{}/ai-usage", team.id);
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;
    for path in [
        format!("{base}?period=30d&timeZone=UTC"),
        format!("{base}/sessions?date=2025-11-02&timeZone=America%2FNew_York"),
    ] {
        let response =
            test::call_service(&app, test::TestRequest::get().uri(&path).to_request()).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&path)
                .insert_header(("Authorization", format!("Bearer {outside_token}")))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&path)
                .insert_header(("Authorization", format!("Bearer {token}")))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let result: Value = test::read_body_json(response).await;
        if result.get("totals").is_some() {
            assert_eq!(result["totals"]["totalTokens"], 0);
            assert_eq!(result["buckets"].as_array().unwrap().len(), 30);
        } else {
            assert_eq!(result["sessions"], json!([]));
        }
    }
    for query in [
        "?period=year&timeZone=UTC",
        "?period=30d&timeZone=bad-zone",
        "?period=30d",
        "?period=30d&timeZone=UTC&unexpected=1",
        "/sessions?date=2025-02-30&timeZone=UTC",
    ] {
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("{base}{query}"))
                .insert_header(("Authorization", format!("Bearer {token}")))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
