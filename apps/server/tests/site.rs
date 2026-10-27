use actix_web::{App, http::StatusCode, test, web};
use deskfleet_server::{AppState, config::ServerConfig, configure};
use sea_orm::{ConnectionTrait, Database};
use serde_json::{Value, json};

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn site_routes_enforce_roles_validate_settings_and_recheck_revocations() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let database = Database::connect(&url).await.unwrap();
    let schema = format!("site_http_{}", uuid::Uuid::new_v4().simple());
    database
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            database_url: format!("{url}{separator}options=-csearch_path%3D{schema}"),
            public_url: "https://control.test".into(),
            web_origins: vec![],
            oidc: None,
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
        .oidc_user("https://site.test", "admin", "Admin", None, false)
        .await
        .unwrap();
    let member = state
        .store
        .oidc_user("https://site.test", "member", "Member", None, false)
        .await
        .unwrap();
    state
        .store
        .create_team(&member.id, "Team administrator's team")
        .await
        .unwrap();
    let admin_login = state.store.new_session(&admin.id).await.unwrap();
    let member_login = state.store.new_session(&member.id).await.unwrap();
    let admin_token = admin_login["token"].as_str().unwrap();
    let member_token = member_login["token"].as_str().unwrap();
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;
    macro_rules! call {
        ($method:ident, $path:expr, $token:expr, $body:expr) => {
            test::call_service(
                &app,
                test::TestRequest::$method()
                    .uri($path)
                    .insert_header(("Authorization", format!("Bearer {}", $token)))
                    .set_json($body)
                    .to_request(),
            )
            .await
        };
    }
    let response =
        test::call_service(&app, test::TestRequest::get().uri("/api/site").to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let defaults: Value = test::read_body_json(response).await;
    assert_eq!(
        defaults,
        json!({"siteName":"deskfleet","announcement":"","allowTeamCreation":true})
    );
    assert_eq!(
        test::call_service(
            &app,
            test::TestRequest::get()
                .uri("/api/admin/site-settings")
                .to_request()
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call!(get, "/api/admin/site-settings", member_token, &json!({})).status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(patch, "/api/admin/site-settings", member_token, &defaults).status(),
        StatusCode::FORBIDDEN
    );
    let me: Value = test::read_body_json(call!(get, "/api/me", admin_token, &json!({}))).await;
    assert_eq!(me["siteAdmin"], false);
    state.store.grant_site_admin(&admin.id).await.unwrap();
    let me: Value = test::read_body_json(call!(get, "/api/me", admin_token, &json!({}))).await;
    assert_eq!(me["siteAdmin"], true);
    let teams: Value =
        test::read_body_json(call!(get, "/api/teams", admin_token, &json!({}))).await;
    assert_eq!(teams, json!([]));
    assert_eq!(
        call!(get, "/api/admin/site-settings", admin_token, &json!({})).status(),
        StatusCode::OK
    );

    let changed =
        json!({"siteName":"Lab fleet", "announcement":"Welcome", "allowTeamCreation":false});
    assert_eq!(
        call!(patch, "/api/admin/site-settings", admin_token, &changed).status(),
        StatusCode::OK
    );
    let public: Value = test::read_body_json(call!(get, "/api/site", "", &json!({}))).await;
    assert_eq!(public, changed);
    for invalid in [
        json!({"siteName":"", "announcement":"", "allowTeamCreation":true}),
        json!({"siteName":"Lab fleet", "announcement":"x".repeat(10_001), "allowTeamCreation":true}),
        json!({"siteName":"Lab fleet"}),
        json!({"siteName":"Lab fleet", "announcement":"", "allowTeamCreation":"yes"}),
        json!({"siteName":"Lab fleet", "announcement":"", "allowTeamCreation":true, "oidcSecret":"not a runtime setting"}),
    ] {
        assert_eq!(
            call!(patch, "/api/admin/site-settings", admin_token, &invalid).status(),
            StatusCode::BAD_REQUEST
        );
    }
    for token in [member_token, admin_token] {
        assert_eq!(
            call!(post, "/api/teams", token, &json!({"name":"Closed"})).status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        call!(patch, "/api/admin/site-settings", admin_token, &defaults).status(),
        StatusCode::OK
    );
    assert_eq!(
        call!(post, "/api/teams", member_token, &json!({"name":"Open"})).status(),
        StatusCode::OK
    );
    state.store.revoke_site_admin(&admin.id).await.unwrap();
    let me: Value = test::read_body_json(call!(get, "/api/me", admin_token, &json!({}))).await;
    assert_eq!(me["siteAdmin"], false);
    assert_eq!(
        call!(get, "/api/admin/site-settings", admin_token, &json!({})).status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(patch, "/api/admin/site-settings", admin_token, &changed).status(),
        StatusCode::FORBIDDEN
    );
    state.store.close().await.unwrap();
    database
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    database.close().await.unwrap();
}
