//! HTTP authorization and signaling tests backed by a real PostgreSQL instance.
use super::*;
use actix_web::{App, http::StatusCode, test};
use deskfleet_control_store::{TurnUsage, TurnUsageSide, now_ms};
use deskfleet_protocol::control::ControlMessage;
use serde_json::{Value, json};

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_http_permissions_replication_and_signaling() {
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
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
    let issuer = format!("https://test/{}", uuid::Uuid::new_v4());
    let user = state
        .store
        .verified_user("owner@test.example", "Owner")
        .await
        .unwrap();
    let outside = state
        .store
        .verified_user(
            &format!(
                "outside-{}@fixture.test",
                issuer.rsplit('/').next().unwrap()
            ),
            "Outside",
        )
        .await
        .unwrap();
    let login = state.store.new_session(&user.id).await.unwrap();
    let outsider = state.store.new_session(&outside.id).await.unwrap();
    let token = login["token"].as_str().unwrap();
    let outside_token = outsider["token"].as_str().unwrap();
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;
    macro_rules! call {
        ($method:ident,$path:expr,$token:expr,$body:expr) => {
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
        test::call_service(&app, test::TestRequest::get().uri("/api/me").to_request()).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let error: Value = test::read_body_json(response).await;
    assert_eq!(error["error"]["code"], "unauthorized");
    assert_eq!(
        call!(
            post,
            "/api/auth/start",
            token,
            &json!({"returnTo":"http://127.0.0.1:4455/auth/callback"})
        )
        .status(),
        StatusCode::OK
    );
    let team: Value = test::read_body_json(call!(
        post,
        "/api/teams",
        token,
        &json!({"name":"API team"})
    ))
    .await;
    let team_id = team["id"].as_str().unwrap();
    let usage_path = format!("/api/teams/{team_id}/usage");
    let response =
        test::call_service(&app, test::TestRequest::get().uri(&usage_path).to_request()).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        call!(get, &usage_path, outside_token, &json!({})).status(),
        StatusCode::FORBIDDEN
    );
    let usage: Value = test::read_body_json(call!(get, &usage_path, token, &json!({}))).await;
    assert_eq!(
        usage_counts(&usage),
        json!({"relayedBytes": "0", "activeSessionCount": 0, "memberCount": 1})
    );
    let teammate = state
        .store
        .verified_user("teammate@test.example", "Teammate")
        .await
        .unwrap();
    let invite = state
        .store
        .invite(&user.id, team_id, "teammate@test.example", "member")
        .await
        .unwrap();
    state
        .store
        .accept_invite(&teammate.id, invite["token"].as_str().unwrap())
        .await
        .unwrap();
    let teammate_login = state.store.new_session(&teammate.id).await.unwrap();
    let teammate_token = teammate_login["token"].as_str().unwrap();
    let usage: Value =
        test::read_body_json(call!(get, &usage_path, teammate_token, &json!({}))).await;
    assert_eq!(usage["memberCount"], 2);
    let (send, mut roster) = tokio::sync::mpsc::channel(128);
    let (shutdown, _shutdown_rx) = tokio::sync::watch::channel(None);
    state
        .hub
        .add_client(
            "teammate-login",
            &teammate.id,
            "teammate-connection",
            send,
            shutdown,
        )
        .await
        .unwrap();
    let (send, mut outside_roster) = tokio::sync::mpsc::channel(128);
    let (shutdown, _shutdown_rx) = tokio::sync::watch::channel(None);
    state
        .hub
        .add_client(
            "outside-login",
            &outside.id,
            "outside-connection",
            send,
            shutdown,
        )
        .await
        .unwrap();
    let path = format!("/api/teams/{team_id}/machines");
    assert_eq!(
        call!(get, &path, outside_token, &json!({})).status(),
        StatusCode::FORBIDDEN
    );
    let enrollment: Value = test::read_body_json(call!(
        post,
        &path,
        token,
        &json!({"name":"Machine","originId":uuid::Uuid::new_v4().to_string(),"localMachineId":"1"})
    ))
    .await;
    let machine_id = enrollment["machine"]["id"].as_str().unwrap();
    let machine_token = enrollment["token"].as_str().unwrap();
    assert!(
        matches!(roster.try_recv().unwrap(), ControlMessage::MachinesChanged { team_id: changed } if changed == team_id)
    );
    assert_eq!(
        call!(
            patch,
            &format!("/api/machines/{machine_id}"),
            token,
            &json!({"name":"Renamed"})
        )
        .status(),
        StatusCode::OK
    );
    assert!(
        matches!(roster.try_recv().unwrap(), ControlMessage::CatalogChanged { machine_id: changed, session_id: None } if changed == machine_id)
    );
    assert!(
        matches!(roster.try_recv().unwrap(), ControlMessage::MachinesChanged { team_id: changed } if changed == team_id)
    );
    // Removing an offline machine must notify its Team even without a daemon disconnect.
    let offline: Value = test::read_body_json(call!(
        post,
        &path,
        token,
        &json!({"name":"Offline","originId":uuid::Uuid::new_v4().to_string(),"localMachineId":"1"})
    ))
    .await;
    assert!(
        matches!(roster.try_recv().unwrap(), ControlMessage::MachinesChanged { team_id: changed } if changed == team_id)
    );
    assert_eq!(
        call!(
            delete,
            &format!(
                "/api/machines/{}",
                offline["machine"]["id"].as_str().unwrap()
            ),
            token,
            &json!({})
        )
        .status(),
        StatusCode::OK
    );
    assert!(
        matches!(roster.try_recv().unwrap(), ControlMessage::MachinesChanged { team_id: changed } if changed == team_id)
    );
    assert!(outside_roster.try_recv().is_err());
    let me: Value =
        test::read_body_json(call!(get, "/api/daemon/me", machine_token, &json!({}))).await;
    assert_eq!(me["machine"]["id"], machine_id);
    assert_eq!(me["serverId"], "https://control.test");
    assert_eq!(
        call!(
            post,
            "/api/daemon/authorize-delegation",
            machine_token,
            &json!({"userId":user.id})
        )
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        call!(
            post,
            "/api/daemon/authorize-delegation",
            machine_token,
            &json!({"userId":outside.id})
        )
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(
            post,
            "/api/daemon/authorize-delegation",
            token,
            &json!({"userId":user.id})
        )
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call!(
            post,
            "/api/daemon/catalog",
            token,
            &json!({"snapshot":{"machineId":"1"}})
        )
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call!(
            post,
            "/api/daemon/catalog",
            machine_token,
            &json!({"snapshot":{"machineId":"2"}})
        )
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(call!(post,"/api/daemon/catalog",machine_token,&json!({"snapshot":{"machineId":"1","workspaces":[]},"providers":{"templates":[{"id":"x","name":"X","binaryPath":"hidden"}],"providers":[{"id":"1","template":"x","name":"X","env":{"SECRET":"hidden"}}]}})).status(),StatusCode::OK);
    let catalog: Value = test::read_body_json(call!(
        get,
        &format!("/api/machines/{machine_id}/catalog"),
        token,
        &json!({})
    ))
    .await;
    assert!(catalog["providers"]["providers"][0].get("env").is_none());
    assert!(
        catalog["providers"]["templates"][0]
            .get("binaryPath")
            .is_none()
    );
    // Capacity follows durable daemon acknowledgements, independently of replicas.
    let mut admission_generation = uuid::Uuid::new_v4().to_string();
    // History remains visible while the machine is offline; archiving still counts.
    for (seq, archive_state, expected) in [
        ("0", "active", 1),
        ("1", "archiving", 1),
        ("2", "archived", 0),
        ("3", "active", 1),
    ] {
        if seq == "0" || seq == "3" {
            admission_generation = uuid::Uuid::new_v4().to_string();
            let kind = if seq == "0" { "create" } else { "restore" };
            let session_id = if seq == "0" { None } else { Some("1") };
            assert_eq!(
                call!(
                    post,
                    "/api/daemon/session-admissions",
                    machine_token,
                    &json!({"operationId":admission_generation,"kind":kind,"sessionId":session_id})
                )
                .status(),
                StatusCode::OK
            );
        }
        let response = call!(
            post,
            "/api/daemon/history",
            machine_token,
            &json!({
                "sessionId":"1", "snapshot":{"session":{"id":"1", "lastEventSeq":seq, "archiveState":archive_state}, "runs":[]}, "events":[]
            })
        );
        assert_eq!(response.status(), StatusCode::OK);
        if seq == "0" || seq == "3" {
            assert_eq!(
                call!(
                    post,
                    &format!("/api/daemon/session-admissions/{admission_generation}/confirm"),
                    machine_token,
                    &json!({"generation":admission_generation,"sessionId":"1"})
                )
                .status(),
                StatusCode::OK
            );
        } else if archive_state == "archived" {
            assert_eq!(
                call!(
                    post,
                    "/api/daemon/session-admissions/release",
                    machine_token,
                    &json!({"generation":admission_generation,"sessionId":"1"})
                )
                .status(),
                StatusCode::OK
            );
        }
        let usage: Value = test::read_body_json(call!(get, &usage_path, token, &json!({}))).await;
        assert_eq!(usage["activeSessionCount"], expected);
    }
    let create = json!({"teamId":team_id,"machineId":machine_id,"purpose":"agent"});
    assert_eq!(
        call!(post, "/api/peers", token, &create).status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let (send, mut receive) = tokio::sync::mpsc::channel(128);
    let (shutdown, _shutdown_rx) = tokio::sync::watch::channel(None);
    state
        .hub
        .add_daemon(machine_id, "fixture", send, shutdown)
        .await
        .unwrap();
    let hub = state.hub.clone();
    let machine = machine_id.to_owned();
    let worker = actix_web::rt::spawn(async move {
        while let Some(message) = receive.recv().await {
            if let ControlMessage::Request {
                id,
                method,
                params,
                actor,
            } = message
            {
                let result = if method == "peer.offer" {
                    json!({"sdp":crate::peers::tests::sdp()})
                } else if method == "_deskfleet/session/rename" {
                    assert_eq!(params["sessionId"], "1");
                    assert_eq!(params["title"], "Renamed investigation");
                    assert!(actor.is_some());
                    json!({"title":"Renamed investigation"})
                } else {
                    assert_eq!(method, "_deskfleet/session/archive");
                    assert_eq!(params["sessionId"], "1");
                    assert!(actor.is_some());
                    json!({"archiveState":"archived"})
                };
                hub.response(&machine, "fixture", &id, Ok(result)).await;
            }
        }
    });
    let grant: Value = test::read_body_json(call!(post, "/api/peers", token, &create)).await;
    let ports = json!({"teamId":team_id,"machineId":machine_id,"purpose":"ports"});
    assert_eq!(
        call!(post, "/api/peers", outside_token, &ports).status(),
        StatusCode::FORBIDDEN
    );
    let response = call!(post, "/api/peers", token, &ports);
    assert_eq!(response.status(), StatusCode::OK);
    let ports_grant: Value = test::read_body_json(response).await;
    assert_eq!(ports_grant["authorization"]["purpose"], "ports");
    assert_eq!(
        ports_grant["authorization"]["actions"],
        json!(["ports:forward"])
    );
    let ports_id = ports_grant["peerId"].as_str().unwrap();
    assert_eq!(
        call!(
            post,
            &format!("/api/peers/{ports_id}/offer"),
            token,
            &json!({"sdp":crate::peers::tests::sdp()})
        )
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        call!(
            post,
            &format!("/api/peers/{ports_id}/start"),
            token,
            &json!({"displayId":"1"})
        )
        .status(),
        StatusCode::FORBIDDEN
    );
    let peer_id = grant["peerId"].as_str().unwrap();
    assert!(uuid::Uuid::parse_str(peer_id).is_ok());
    for side in [TurnUsageSide::Client, TurnUsageSide::Peer] {
        state
            .store
            .record_turn_usage(&TurnUsage {
                peer_id: peer_id.into(),
                realm: "turn.test".into(),
                allocation_id: "1".into(),
                side,
                received_bytes: 500,
                sent_bytes: i64::MAX,
                collected_at: now_ms(),
            })
            .await
            .unwrap();
    }
    for member_token in [token, teammate_token] {
        let response = call!(get, &usage_path, member_token, &json!({}));
        assert_eq!(response.status(), StatusCode::OK);
        let usage: Value = test::read_body_json(response).await;
        assert_eq!(
            usage_counts(&usage),
            json!({"relayedBytes": "18446744073709551614", "activeSessionCount": 1, "memberCount": 2})
        );
    }
    let other_team = state
        .store
        .create_team(&outside.id, "Other team")
        .await
        .unwrap();
    let other_usage_path = format!("/api/teams/{}/usage", other_team.id);
    assert_eq!(
        call!(get, &other_usage_path, token, &json!({})).status(),
        StatusCode::FORBIDDEN
    );
    let other_usage: Value =
        test::read_body_json(call!(get, &other_usage_path, outside_token, &json!({}))).await;
    assert_eq!(
        usage_counts(&other_usage),
        json!({"relayedBytes": "0", "activeSessionCount": 0, "memberCount": 1})
    );
    let auth = &grant["authorization"];
    let expires =
        chrono::DateTime::parse_from_rfc3339(auth["expiresAt"].as_str().unwrap()).unwrap();
    let issued = chrono::DateTime::parse_from_rfc3339(auth["issuedAt"].as_str().unwrap()).unwrap();
    assert_eq!((expires - issued).num_seconds(), 86400);
    assert_eq!(auth["actor"]["userId"], user.id);
    let offer_path = format!("/api/peers/{peer_id}/offer");
    let offer = json!({"sdp":crate::peers::tests::sdp()});
    assert_eq!(
        call!(post, &offer_path, outside_token, &offer).status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call!(post, &offer_path, token, &json!({"sdp":"invalid"})).status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call!(post, &offer_path, token, &offer).status(),
        StatusCode::OK
    );
    assert_eq!(
        call!(post, &offer_path, token, &offer).status(),
        StatusCode::OK
    );
    let changed =
        json!({"sdp":crate::peers::tests::sdp().replace("ice-ufrag:one","ice-ufrag:changed")});
    assert_eq!(
        call!(post, &offer_path, token, &changed).status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call!(
            post,
            &format!("/api/peers/{peer_id}/start"),
            token,
            &json!({"displayId":"1"})
        )
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(
            post,
            &format!("/api/machines/{machine_id}/rpc"),
            token,
            &json!({"method":"session/prompt","params":{}})
        )
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(call!(post,&format!("/api/machines/{machine_id}/rpc"),token,&json!({"method":"_deskfleet/session/archive","params":{"sessionId":"1","operationId":"fixture"}})).status(),StatusCode::OK);
    let rename = json!({"method":"_deskfleet/session/rename","params":{"sessionId":"1","operationId":"rename-fixture","title":"Renamed investigation"}});
    assert_eq!(
        call!(
            post,
            &format!("/api/machines/{machine_id}/rpc"),
            outside_token,
            &rename
        )
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(
            post,
            &format!("/api/machines/{machine_id}/rpc"),
            token,
            &rename
        )
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        call!(post, "/api/auth/logout", token, &json!({})).status(),
        StatusCode::NO_CONTENT
    );
    assert!(
        state
            .store
            .valid_machine_peers(machine_id)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call!(get, "/api/me", token, &json!({})).status(),
        StatusCode::UNAUTHORIZED
    );
    state.hub.remove_daemon(machine_id, "fixture").await;
    let renewed_login = state.store.new_session(&user.id).await.unwrap();
    let renewed_token = renewed_login["token"].as_str().unwrap();
    let usage: Value =
        test::read_body_json(call!(get, &usage_path, renewed_token, &json!({}))).await;
    assert_eq!(usage["activeSessionCount"], 1);
    // Persistent schedule intent survives a login ending, but not Team membership removal.
    assert_eq!(
        call!(
            post,
            "/api/daemon/authorize-delegation",
            machine_token,
            &json!({"userId":user.id})
        )
        .status(),
        StatusCode::OK
    );
    state
        .store
        .change_member(&user.id, team_id, &teammate.id, None)
        .await
        .unwrap();
    assert_eq!(
        call!(get, &usage_path, teammate_token, &json!({})).status(),
        StatusCode::FORBIDDEN
    );
    let usage: Value =
        test::read_body_json(call!(get, &usage_path, renewed_token, &json!({}))).await;
    assert_eq!(usage["memberCount"], 1);
    assert_eq!(
        call!(
            post,
            "/api/daemon/authorize-delegation",
            machine_token,
            &json!({"userId":teammate.id})
        )
        .status(),
        StatusCode::FORBIDDEN
    );
    state
        .store
        .revoke_machine(&user.id, machine_id)
        .await
        .unwrap();
    let usage: Value =
        test::read_body_json(call!(get, &usage_path, renewed_token, &json!({}))).await;
    assert_eq!(
        usage_counts(&usage),
        json!({"relayedBytes": "18446744073709551614", "activeSessionCount": 0, "memberCount": 1})
    );
    assert_eq!(
        call!(
            post,
            "/api/daemon/authorize-delegation",
            machine_token,
            &json!({"userId":user.id})
        )
        .status(),
        StatusCode::UNAUTHORIZED
    );
    worker.abort();
    state.store.close().await.unwrap();
}

fn usage_counts(value: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({"relayedBytes":value["relayedBytes"],"activeSessionCount":value["activeSessionCount"],"memberCount":value["memberCount"]})
}
