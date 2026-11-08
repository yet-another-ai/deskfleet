//! Site administrators can provision verified accounts.
use actix_web::{App, http::StatusCode, test, web};
use deskfleet_server::{AppState, config::ServerConfig, configure};
use sea_orm::{ConnectionTrait, Database};
use serde_json::{Value, json};

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn only_site_administrators_can_create_verified_accounts() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let database = Database::connect(&url).await.unwrap();
    let schema = format!("account_creation_http_{}", uuid::Uuid::new_v4().simple());
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
    let admin_token = state.store.new_session(&admin.id).await.unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let member_token = state.store.new_session(&member.id).await.unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
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
    let account = json!({
        "name": "New User",
        "email": "newuser@fixture.test",
        "password": "a-very-long-test-password"
    });
    assert_eq!(
        call!(post, "/api/admin/users", member_token, &account).status(),
        StatusCode::FORBIDDEN
    );
    let created: Value =
        test::read_body_json(call!(post, "/api/admin/users", admin_token, &account)).await;
    assert_eq!(created["name"], "New User");
    assert_eq!(created["email"], "newuser@fixture.test");
    assert_eq!(created["disabled"], false);
    assert!(
        state
            .store
            .password_credentials("newuser@fixture.test")
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        call!(post, "/api/admin/users", admin_token, &account).status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        call!(
            post,
            "/api/admin/users",
            admin_token,
            &json!({"name":"Short", "email":"short@fixture.test", "password":"short"})
        )
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call!(
            post,
            "/api/admin/users",
            admin_token,
            &json!({"name":"Unknown", "email":"unknown@fixture.test", "password":"a-very-long-test-password", "siteAdmin":true})
        )
        .status(),
        StatusCode::BAD_REQUEST
    );
    let results: Value = test::read_body_json(call!(
        get,
        "/api/admin/users?query=newuser",
        admin_token,
        &json!({})
    ))
    .await;
    assert_eq!(results[0]["email"], "newuser@fixture.test");
    state.store.close().await.unwrap();
    database
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    database.close().await.unwrap();
}
