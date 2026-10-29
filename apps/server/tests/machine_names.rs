//! A machine's Team name is chosen at enrollment, editable later, and shown in place of its hostname.
use actix_web::{App, http::StatusCode, test, web};
use deskfleet_server::{AppState, config::ServerConfig, configure};
use serde_json::{Value, json};

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn team_members_rename_machines_and_catalogs_use_the_team_name() {
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL"),
            public_url: "https://control.test".into(),
            web_origins: vec![],
            auth: deskfleet_server::auth::config::AuthConfig::development("https://control.test"),
            billing: Default::default(),
            stun_urls: vec![],
            turn_urls: vec![],
            turn_secret: None,
            turn_usage_redis_url: None,
        })
        .await
        .unwrap(),
    );
    let issuer = format!("https://fixture/{}", uuid::Uuid::new_v4());
    let admin = state
        .store
        .verified_user(
            &format!("admin-{}@fixture.test", issuer.rsplit('/').next().unwrap()),
            "Admin",
        )
        .await
        .unwrap();
    let member = state
        .store
        .verified_user("member@example.test", "Member")
        .await
        .unwrap();
    let outsider = state
        .store
        .verified_user(
            &format!(
                "outsider-{}@fixture.test",
                issuer.rsplit('/').next().unwrap()
            ),
            "Outsider",
        )
        .await
        .unwrap();
    let team = state
        .store
        .create_team(&admin.id, "Named team")
        .await
        .unwrap();
    let invite = state
        .store
        .invite(&admin.id, &team.id, "member@example.test", "member")
        .await
        .unwrap();
    state
        .store
        .accept_invite(&member.id, invite["token"].as_str().unwrap())
        .await
        .unwrap();
    let admin_login = state.store.new_session(&admin.id).await.unwrap();
    let member_login = state.store.new_session(&member.id).await.unwrap();
    let outsider_login = state.store.new_session(&outsider.id).await.unwrap();
    let admin_token = admin_login["token"].as_str().unwrap();
    let member_token = member_login["token"].as_str().unwrap();
    let outsider_token = outsider_login["token"].as_str().unwrap();
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
    let enrolled: Value = test::read_body_json(call!(
        post,
        &format!("/api/teams/{}/machines", team.id),
        admin_token,
        &json!({"name":"build-01","originId":uuid::Uuid::new_v4().to_string(),"localMachineId":"1"})
    ))
    .await;
    let machine_id = enrolled["machine"]["id"].as_str().unwrap();
    let machine_token = enrolled["token"].as_str().unwrap();
    assert_eq!(
        call!(
            post,
            "/api/daemon/catalog",
            machine_token,
            &json!({"snapshot":{"teamId":"1","machineId":"1","machineName":"ip-10-0-0-12","workspaces":[]}})
        )
        .status(),
        StatusCode::OK
    );
    let catalog_path = format!("/api/machines/{machine_id}/catalog");
    let catalog: Value =
        test::read_body_json(call!(get, &catalog_path, member_token, &json!({}))).await;
    assert_eq!(catalog["snapshot"]["machineName"], "build-01");

    let path = format!("/api/machines/{machine_id}");
    let renamed: Value = test::read_body_json(call!(
        patch,
        &path,
        member_token,
        &json!({"name":"  GPU runner  "})
    ))
    .await;
    assert_eq!(renamed["id"], machine_id);
    assert_eq!(renamed["name"], "GPU runner");
    let catalog: Value =
        test::read_body_json(call!(get, &catalog_path, member_token, &json!({}))).await;
    assert_eq!(catalog["snapshot"]["machineName"], "GPU runner");
    let machines: Value = test::read_body_json(call!(
        get,
        &format!("/api/teams/{}/machines", team.id),
        admin_token,
        &json!({})
    ))
    .await;
    assert_eq!(machines[0]["name"], "GPU runner");

    assert_eq!(
        call!(patch, &path, member_token, &json!({"name":"   "})).status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call!(patch, &path, outsider_token, &json!({"name":"Taken over"})).status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(delete, &path, admin_token, &json!({})).status(),
        StatusCode::OK
    );
    assert_eq!(
        call!(patch, &path, admin_token, &json!({"name":"Revoked"})).status(),
        StatusCode::NOT_FOUND
    );
    state.store.close().await.unwrap();
}
