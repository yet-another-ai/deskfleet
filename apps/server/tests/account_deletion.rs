//! Account deletion request and review HTTP boundaries.
use actix_web::{App, http::StatusCode, test, web};
use deskfleet_server::{AppState, config::ServerConfig, configure};
use sea_orm::{ConnectionTrait, Database};
use serde_json::{Value, json};

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn deletion_requests_are_self_scoped_and_site_admin_reviewed() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let database = Database::connect(&url).await.unwrap();
    let schema = format!("account_deletion_http_{}", uuid::Uuid::new_v4().simple());
    database
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: format!("{url}{separator}options=-csearch_path%3D{schema}"),
            public_url: "https://control.test".into(),
            web_origins: vec![],
            auth: deskfleet_server::auth::config::AuthConfig::development("https://control.test"),
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
    let admin = state
        .store
        .verified_user(
            &format!("admin-{}@fixture.test", uuid::Uuid::new_v4()),
            "Admin",
        )
        .await
        .unwrap();
    let member = state
        .store
        .verified_user(
            &format!("member-{}@fixture.test", uuid::Uuid::new_v4()),
            "Member",
        )
        .await
        .unwrap();
    state.store.grant_site_admin(&admin.id).await.unwrap();
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

    let request: Value = test::read_body_json(call!(
        post,
        "/api/auth/account-deletion",
        member_token,
        &json!({"reason":"Moving on"})
    ))
    .await;
    assert_eq!(request["status"], "pending");
    assert_eq!(
        call!(
            post,
            "/api/auth/account-deletion",
            member_token,
            &json!({"reason":"Again"})
        )
        .status(),
        StatusCode::CONFLICT
    );
    let latest: Value = test::read_body_json(call!(
        get,
        "/api/auth/account-deletion",
        member_token,
        &json!({})
    ))
    .await;
    assert_eq!(latest["request"]["id"], request["id"]);
    assert_eq!(
        call!(
            get,
            "/api/admin/account-deletion-requests",
            member_token,
            &json!({})
        )
        .status(),
        StatusCode::FORBIDDEN
    );
    let page: Value = test::read_body_json(call!(
        get,
        "/api/admin/account-deletion-requests",
        admin_token,
        &json!({})
    ))
    .await;
    assert_eq!(page["requests"][0]["user"]["id"], member.id);
    let review_path = format!(
        "/api/admin/account-deletion-requests/{}/review",
        request["id"].as_str().unwrap()
    );
    assert_eq!(
        call!(post, &review_path, member_token, &json!({"approve":true})).status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(
            post,
            &review_path,
            admin_token,
            &json!({"approve":true,"note":"Verified"})
        )
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call!(get, "/api/auth/account-deletion", member_token, &json!({})).status(),
        StatusCode::UNAUTHORIZED
    );
    let page: Value = test::read_body_json(call!(
        get,
        "/api/admin/account-deletion-requests",
        admin_token,
        &json!({})
    ))
    .await;
    assert_eq!(page["requests"], json!([]));
    state.store.close().await.unwrap();
    database
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    database.close().await.unwrap();
}
