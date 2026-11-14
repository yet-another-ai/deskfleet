use actix_web::{App, http::StatusCode, test, web};
use serde_json::Value;

use crate::{AppState, config::ServerConfig, configure};

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn usage_trends_requires_current_site_grant_and_bounded_period() {
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL"),
            public_url: "https://control.test".into(),
            web_origins: vec![],
            auth: crate::auth::config::AuthConfig::development("https://control.test"),
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
    let user = state
        .store
        .verified_user(
            &format!("trends-{}@fixture.test", uuid::Uuid::new_v4()),
            "Admin",
        )
        .await
        .unwrap();
    let login = state.store.new_session(&user.id).await.unwrap();
    let token = login["token"].as_str().unwrap();
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;
    let path = "/api/admin/usage-trends?period=7d";
    let response = test::call_service(&app, test::TestRequest::get().uri(path).to_request()).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let request = |path: &str| {
        test::TestRequest::get()
            .uri(path)
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request()
    };
    let response = test::call_service(&app, request(path)).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    state.store.grant_site_admin(&user.id).await.unwrap();
    // No Team membership or recent-authentication write flow is required to read aggregates.
    for (period, days) in [("7d", 7), ("30d", 30), ("90d", 90)] {
        let response = test::call_service(
            &app,
            request(&format!("/api/admin/usage-trends?period={period}")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let usage: Value = test::read_body_json(response).await;
        assert_eq!(usage["period"], period);
        assert_eq!(usage["timeZone"], "UTC");
        assert_eq!(usage["buckets"].as_array().unwrap().len(), days);
        assert!(usage["totals"]["users"].as_u64().unwrap() > 0);
        assert!(usage["buckets"][0]["relayedBytes"].is_string());
    }
    for query in ["", "?period=all", "?period=30d&timeZone=UTC"] {
        let response =
            test::call_service(&app, request(&format!("/api/admin/usage-trends{query}"))).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    state.store.revoke_site_admin(&user.id).await.unwrap();
    let response = test::call_service(&app, request(path)).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
