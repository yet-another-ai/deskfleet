//! Re-enrollment starts a new machine identity while retaining Team membership.
use actix_web::{App, http::StatusCode, test, web};
use deskfleet_server::{AppState, config::ServerConfig, configure};
use serde_json::{Value, json};

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn revoked_machine_rejoins_original_team_only_with_a_fresh_origin() {
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL"),
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
    let issuer = format!("https://fixture/{}", uuid::Uuid::new_v4());
    let user = state
        .store
        .verified_user(
            &format!("owner-{}@fixture.test", issuer.rsplit('/').next().unwrap()),
            "Owner",
        )
        .await
        .unwrap();
    let login = state.store.new_session(&user.id).await.unwrap();
    let token = login["token"].as_str().unwrap();
    let team = state
        .store
        .create_team(&user.id, "Retained team")
        .await
        .unwrap();
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
    // Missing credentials and rejected user sessions do not prove that a
    // daemon's machine credential has been retired.
    for (path, credential, expected_code) in [
        ("/api/me", None, "unauthorized"),
        ("/api/daemon/me", None, "unauthorized"),
        ("/api/me", Some("unknown-token"), "unauthorized"),
        (
            "/api/daemon/me",
            Some("unknown-token"),
            "machine_credential_rejected",
        ),
    ] {
        let mut request = test::TestRequest::get().uri(path);
        if let Some(credential) = credential {
            request = request.insert_header(("Authorization", format!("Bearer {credential}")));
        }
        let response = test::call_service(&app, request.to_request()).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let error: Value = test::read_body_json(response).await;
        assert_eq!(error["error"]["code"], expected_code);
    }
    let registration_path = format!("/api/teams/{}/machines", team.id);
    let old_origin = uuid::Uuid::new_v4().to_string();
    let registration = json!({"name":"Old machine","originId":old_origin,"localMachineId":"1"});
    let old: Value =
        test::read_body_json(call!(post, &registration_path, token, &registration)).await;
    let old_id = old["machine"]["id"].as_str().unwrap();
    let old_token = old["token"].as_str().unwrap();
    assert_eq!(call!(post, "/api/daemon/history", old_token, &json!({
        "sessionId":"1", "snapshot":{"session":{"id":"1","lastEventSeq":"0","archiveState":"active"}},
        "events":[], "commands":[]
    })).status(), StatusCode::OK);
    assert_eq!(
        call!(
            delete,
            &format!("/api/machines/{old_id}"),
            token,
            &json!({})
        )
        .status(),
        StatusCode::OK
    );
    let rejected = call!(get, "/api/daemon/me", old_token, &json!({}));
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    let error: Value = test::read_body_json(rejected).await;
    assert_eq!(error["error"]["code"], "machine_credential_rejected");
    assert_eq!(
        call!(post, "/api/auth/logout", token, &json!({})).status(),
        StatusCode::NO_CONTENT
    );

    // A new login for the same verified account retains Team membership.
    let returning_user = state
        .store
        .verified_user(
            &format!("owner-{}@fixture.test", issuer.rsplit('/').next().unwrap()),
            "Owner",
        )
        .await
        .unwrap();
    assert_eq!(returning_user.id, user.id);
    let login = state.store.new_session(&returning_user.id).await.unwrap();
    let token = login["token"].as_str().unwrap();
    let teams: Value = test::read_body_json(call!(get, "/api/teams", token, &json!({}))).await;
    assert!(
        teams
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value["id"] == team.id)
    );
    assert_eq!(
        call!(post, &registration_path, token, &registration).status(),
        StatusCode::CONFLICT
    );
    let fresh: Value = test::read_body_json(call!(
        post,
        &registration_path,
        token,
        &json!({
            "name":"Fresh machine","originId":uuid::Uuid::new_v4().to_string(),"localMachineId":"1"
        })
    ))
    .await;
    let new_id = fresh["machine"]["id"].as_str().unwrap();
    assert_ne!(new_id, old_id);
    assert_eq!(fresh["machine"]["teamId"], team.id);
    assert_ne!(fresh["token"], old["token"]);
    assert_eq!(
        call!(
            get,
            "/api/daemon/me",
            fresh["token"].as_str().unwrap(),
            &json!({})
        )
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        call!(get, "/api/daemon/me", old_token, &json!({})).status(),
        StatusCode::UNAUTHORIZED
    );
    let sessions: Value = test::read_body_json(call!(
        get,
        &format!("/api/machines/{new_id}/sessions"),
        token,
        &json!({})
    ))
    .await;
    assert_eq!(sessions["sessions"], json!([]));
    let machines: Value =
        test::read_body_json(call!(get, &registration_path, token, &json!({}))).await;
    assert_eq!(machines.as_array().unwrap().len(), 1);
    assert_eq!(machines[0]["id"], new_id);
    // Old history remains scoped to the revoked identity, never imported into
    // the new machine even when both local catalogs allocated Session ID 1.
    assert_eq!(
        state.store.session_snapshot(old_id, "1").await.unwrap()["snapshot"]["session"]["id"],
        "1"
    );
    state.store.close().await.unwrap();
}
