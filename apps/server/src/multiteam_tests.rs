//! One public Machine identity, independently authorized Team registrations.
use crate::{AppState, config::ServerConfig, configure};
use actix_web::{App, http::StatusCode, test, web};
use deskfleet_protocol::control::ControlMessage;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn one_machine_keeps_team_history_routes_and_revocation_isolated() {
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
    let owner = state
        .store
        .verified_user(
            &format!("multi-owner-{}@fixture.test", uuid::Uuid::new_v4()),
            "Owner",
        )
        .await
        .unwrap();
    let member = state
        .store
        .verified_user(
            &format!("multi-member-{}@fixture.test", uuid::Uuid::new_v4()),
            "Member",
        )
        .await
        .unwrap();
    let a = state.store.create_team(&owner.id, "A").await.unwrap();
    let b = state.store.create_team(&owner.id, "B").await.unwrap();
    let invite = state
        .store
        .invite(&owner.id, &a.id, member.email.as_deref().unwrap(), "member")
        .await
        .unwrap();
    state
        .store
        .accept_invite(&member.id, invite["token"].as_str().unwrap())
        .await
        .unwrap();
    let login = state.store.new_session(&owner.id).await.unwrap();
    let member_login = state.store.new_session(&member.id).await.unwrap();
    let token = login["token"].as_str().unwrap();
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
    let identity = deskfleet_control_store::secret();
    let enrollment_a = json!({"name":"A machine", "identityToken":identity,
        "originId":uuid::Uuid::new_v4().to_string(), "localMachineId":"1"});
    let enrollment_b = json!({"name":"B machine", "identityToken":identity,
        "originId":uuid::Uuid::new_v4().to_string(), "localMachineId":"1"});
    let path_a = format!("/api/teams/{}/machines", a.id);
    let path_b = format!("/api/teams/{}/machines", b.id);
    let first: Value = test::read_body_json(call!(post, &path_a, token, &enrollment_a)).await;
    let second: Value = test::read_body_json(call!(post, &path_b, token, &enrollment_b)).await;
    assert_eq!(first["machine"]["id"], second["machine"]["id"]);
    assert_ne!(first["machine"]["originId"], second["machine"]["originId"]);
    let public_id = first["machine"]["id"].as_str().unwrap();
    let token_a = first["token"].as_str().unwrap();
    let token_b = second["token"].as_str().unwrap();
    let registration_a = state
        .store
        .authenticate_machine(token_a)
        .await
        .unwrap()
        .machine;
    let registration_b = state
        .store
        .authenticate_machine(token_b)
        .await
        .unwrap()
        .machine;
    assert_ne!(registration_a.id, registration_b.id);
    assert_eq!(
        call!(post, &path_a, token, &enrollment_a).status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        call!(post, &path_b, member_token, &enrollment_b).status(),
        StatusCode::FORBIDDEN
    );
    for (credential, title) in [(token_a, "Only A"), (token_b, "Only B")] {
        assert_eq!(
            call!(
                post,
                "/api/daemon/catalog",
                credential,
                &json!({
                    "snapshot":{"machineId":"1", "workspaces":[], "sessionIds":["1"]}
                })
            )
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            call!(
                post,
                "/api/daemon/history",
                credential,
                &json!({
                    "sessionId":"1", "snapshot":{"session":{"id":"1","title":title,
                        "lastEventSeq":"0","archiveState":"active"}}, "events":[], "commands":[]
                })
            )
            .status(),
            StatusCode::OK
        );
    }
    for (team, title) in [(&a.id, "Only A"), (&b.id, "Only B")] {
        let base = format!("/api/teams/{team}/machines/{public_id}");
        let history: Value =
            test::read_body_json(call!(get, &format!("{base}/sessions/1"), token, &json!({})))
                .await;
        assert_eq!(history["snapshot"]["session"]["title"], title);
        let listed: Value =
            test::read_body_json(call!(get, &format!("{base}/sessions"), token, &json!({}))).await;
        assert_eq!(listed["sessions"][0]["session"]["title"], title);
        let catalog: Value =
            test::read_body_json(call!(get, &format!("{base}/catalog"), token, &json!({}))).await;
        assert_eq!(catalog["machineId"], public_id);
    }
    let resource_a = format!("{path_a}/{public_id}");
    let resource_b = format!("{path_b}/{public_id}");
    assert_eq!(
        call!(
            get,
            &format!("{resource_b}/sessions/1"),
            member_token,
            &json!({})
        )
        .status(),
        StatusCode::FORBIDDEN
    );

    let (send_a, mut requests_a) = mpsc::channel(16);
    let (shutdown_a, stopped_a) = watch::channel(None);
    state
        .hub
        .add_daemon(
            &registration_a.id,
            &a.id,
            public_id,
            "A",
            send_a,
            shutdown_a,
        )
        .await
        .unwrap();
    let (send_b, mut requests_b) = mpsc::channel(16);
    let (shutdown_b, stopped_b) = watch::channel(None);
    state
        .hub
        .add_daemon(
            &registration_b.id,
            &b.id,
            public_id,
            "B",
            send_b,
            shutdown_b,
        )
        .await
        .unwrap();
    assert!(state.hub.online(&registration_a.id).await);
    assert!(state.hub.online(&registration_b.id).await);

    // The public Machine ID is identical; the Team in the URL selects the socket.
    for (path, registration, connection, requests) in [
        (&resource_a, &registration_a.id, "A", &mut requests_a),
        (&resource_b, &registration_b.id, "B", &mut requests_b),
    ] {
        let request = test::TestRequest::post()
            .uri(&format!("{path}/rpc"))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(json!({"method":"catalogList", "params":{}}))
            .to_request();
        let respond = async {
            let ControlMessage::Request { id, method, .. } = requests.recv().await.unwrap() else {
                panic!("expected RPC")
            };
            assert_eq!(method, "catalogList");
            state
                .hub
                .response(
                    registration,
                    connection,
                    &id,
                    Ok(json!({"team":connection})),
                )
                .await;
        };
        let (response, ()) = tokio::join!(test::call_service(&app, request), respond);
        assert_eq!(response.status(), StatusCode::OK);
        let result: Value = test::read_body_json(response).await;
        assert_eq!(result["team"], connection);
    }
    for team in [&a.id, &b.id] {
        let peer: Value = test::read_body_json(call!(
            post,
            "/api/peers",
            token,
            &json!({
                "teamId":team,"machineId":public_id,"purpose":"agent"
            })
        ))
        .await;
        assert_eq!(peer["authorization"]["targetMachine"]["id"], public_id);
        assert_eq!(peer["authorization"]["teamId"], *team);
    }
    assert_eq!(
        call!(delete, &resource_a, token, &json!({})).status(),
        StatusCode::OK
    );
    assert_eq!(*stopped_a.borrow(), Some(4403));
    assert!(stopped_b.borrow().is_none());
    assert!(requests_b.try_recv().is_err());
    assert_eq!(
        call!(get, "/api/daemon/me", token_a, &json!({})).status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call!(get, "/api/daemon/me", token_b, &json!({})).status(),
        StatusCode::OK
    );
    assert_eq!(
        call!(get, &format!("{resource_b}/sessions/1"), token, &json!({})).status(),
        StatusCode::OK
    );
    assert!(
        state
            .store
            .valid_machine_peers(&registration_a.id)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        state
            .store
            .valid_machine_peers(&registration_b.id)
            .await
            .unwrap()
            .len(),
        1
    );
    let restored: Value = test::read_body_json(call!(post, &path_a, token, &enrollment_a)).await;
    assert_eq!(restored["machine"]["id"], public_id);
    assert_ne!(restored["token"], first["token"]);
    let restored_registration = state
        .store
        .authenticate_machine(restored["token"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(restored_registration.machine.id, registration_a.id);
    let history: Value = test::read_body_json(call!(
        get,
        &format!("{resource_a}/sessions/1"),
        token,
        &json!({})
    ))
    .await;
    assert_eq!(history["snapshot"]["session"]["title"], "Only A");
    state.hub.remove_daemon(&registration_a.id, "A").await;
    state.hub.remove_daemon(&registration_b.id, "B").await;
}
