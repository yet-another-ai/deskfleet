use crate::{AppState, config::ServerConfig, configure};
use actix_web::{App, http::StatusCode, test, web};
use deskfleet_control_store::{MachineRegistration, secret};
use deskfleet_protocol::control::ControlMessage;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

async fn enroll(
    state: &AppState,
    user: &str,
    team: &str,
    identity: &str,
) -> (MachineRegistration, String) {
    state
        .store
        .enroll(
            user,
            team,
            "MCP machine",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
            identity,
        )
        .await
        .unwrap()
}

async fn responder(
    state: &AppState,
    machine: &MachineRegistration,
    allowed: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    let (send, mut receive) = tokio::sync::mpsc::channel(32);
    let (shutdown, _shutdown_rx) = tokio::sync::watch::channel(None);
    state
        .hub
        .add_daemon(
            &machine.id,
            &machine.team_id,
            &machine.machine_id,
            "mcp-fixture",
            send,
            shutdown,
        )
        .await
        .unwrap();
    let hub = state.hub.clone();
    let machine = machine.clone();
    tokio::spawn(async move {
        while let Some(message) = receive.recv().await {
            if let ControlMessage::Request {
                id,
                method,
                params,
                actor,
            } = message
            {
                let result = match method.as_str() {
                    "remoteMcpDiscover" => Ok(
                        json!({"allowRead": allowed.load(Ordering::SeqCst), "allowOperate": false}),
                    ),
                    "remoteMcp" if allowed.load(Ordering::SeqCst) => {
                        Ok(json!({"registrationId": machine.id, "params": params, "actor": actor}))
                    }
                    _ => Err(crate::error::ApiError::forbidden()),
                };
                hub.response(&machine.id, "mcp-fixture", &id, result).await;
            }
        }
    })
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_remote_mcp_uses_source_team_and_live_consent() {
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
            &format!("mcp-owner-{}@fixture.test", uuid::Uuid::new_v4()),
            "Owner",
        )
        .await
        .unwrap();
    let outside = state
        .store
        .verified_user(
            &format!("mcp-outside-{}@fixture.test", uuid::Uuid::new_v4()),
            "Outside",
        )
        .await
        .unwrap();
    let login = state.store.new_session(&owner.id).await.unwrap();
    let a = state.store.create_team(&owner.id, "MCP A").await.unwrap();
    let b = state.store.create_team(&owner.id, "MCP B").await.unwrap();
    let (source, credential) = enroll(&state, &owner.id, &a.id, &secret()).await;
    let identity = secret();
    let (target_a, _) = enroll(&state, &owner.id, &a.id, &identity).await;
    let (target_b, _) = enroll(&state, &owner.id, &b.id, &identity).await;
    let (only_b, _) = enroll(&state, &owner.id, &b.id, &secret()).await;
    let (denied, _) = enroll(&state, &owner.id, &a.id, &secret()).await;
    let (offline, _) = enroll(&state, &owner.id, &a.id, &secret()).await;
    let (stalled, _) = enroll(&state, &owner.id, &a.id, &secret()).await;
    let (send, mut stalled_requests) = tokio::sync::mpsc::channel(8);
    let (shutdown, _shutdown_rx) = tokio::sync::watch::channel(None);
    state
        .hub
        .add_daemon(
            &stalled.id,
            &stalled.team_id,
            &stalled.machine_id,
            "stalled",
            send,
            shutdown,
        )
        .await
        .unwrap();
    assert_eq!(target_a.machine_id, target_b.machine_id);
    let consent = Arc::new(AtomicBool::new(true));
    let worker_a = responder(&state, &target_a, consent.clone()).await;
    let worker_b = responder(&state, &target_b, Arc::new(AtomicBool::new(true))).await;
    let worker_denied = responder(&state, &denied, Arc::new(AtomicBool::new(false))).await;
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;
    macro_rules! call {
        ($token:expr, $body:expr) => {
            test::call_service(
                &app,
                test::TestRequest::post()
                    .uri("/api/daemon/mcp")
                    .insert_header(("Authorization", format!("Bearer {}", $token)))
                    .set_json($body)
                    .to_request(),
            )
            .await
        };
    }
    let mut request = json!({"userId": owner.id, "deviceId": "initiating-login", "sessionId": "source-session", "operation": "machines", "arguments": {}});
    assert_eq!(
        call!(login["token"].as_str().unwrap(), &request).status(),
        StatusCode::UNAUTHORIZED
    );
    // One routed daemon that never replies must not hide the responsive machine.
    let response = tokio::time::timeout(
        super::DISCOVERY_TIMEOUT + std::time::Duration::from_secs(5),
        async { call!(&credential, &request) },
    )
    .await
    .expect("discovery must finish before the source's 55-second HTTP timeout");
    assert_eq!(response.status(), StatusCode::OK);
    let listed: Value = test::read_body_json(response).await;
    assert_eq!(listed["teamId"], a.id);
    assert_eq!(listed["machines"].as_array().unwrap().len(), 1);
    assert_eq!(listed["machines"][0]["machine"]["id"], target_a.machine_id);
    assert!(
        matches!(stalled_requests.try_recv(), Ok(ControlMessage::Request { method, .. }) if method == "remoteMcpDiscover")
    );

    request["operation"] = json!("session");
    request["machineId"] = json!(target_a.machine_id);
    request["arguments"] = json!({"sessionId":"remote-session"});

    let invitation = state
        .store
        .invite(
            &owner.id,
            &a.id,
            outside.email.as_deref().unwrap(),
            "member",
        )
        .await
        .unwrap();
    state
        .store
        .accept_invite(&outside.id, invitation["token"].as_str().unwrap())
        .await
        .unwrap();
    request["userId"] = json!(outside.id);
    assert_eq!(call!(&credential, &request).status(), StatusCode::OK);
    state
        .store
        .change_member(&owner.id, &a.id, &outside.id, None)
        .await
        .unwrap();
    assert_eq!(call!(&credential, &request).status(), StatusCode::FORBIDDEN);
    request["userId"] = json!(owner.id);
    let response = call!(&credential, &request);
    assert_eq!(response.status(), StatusCode::OK);
    let forwarded: Value = test::read_body_json(response).await;
    assert_eq!(forwarded["registrationId"], target_a.id);
    assert_eq!(
        forwarded["params"]["source"],
        json!({"teamId": a.id, "machineId": source.machine_id, "sessionId": "source-session"})
    );
    assert_eq!(
        forwarded["params"]["arguments"],
        json!({"sessionId":"remote-session"})
    );
    assert_eq!(forwarded["actor"]["userId"], owner.id);
    assert_eq!(forwarded["actor"]["sourceMachine"]["id"], source.machine_id);

    for (target, expected) in [
        (&only_b.machine_id, StatusCode::NOT_FOUND),
        (&source.machine_id, StatusCode::BAD_REQUEST),
        (&offline.machine_id, StatusCode::SERVICE_UNAVAILABLE),
    ] {
        request["machineId"] = json!(target);
        assert_eq!(call!(&credential, &request).status(), expected);
    }
    request["machineId"] = json!(target_a.machine_id);
    request["teamId"] = json!(b.id);
    assert_eq!(
        call!(&credential, &request).status(),
        StatusCode::BAD_REQUEST
    );
    request.as_object_mut().unwrap().remove("teamId");
    request["userId"] = json!(outside.id);
    assert_eq!(call!(&credential, &request).status(), StatusCode::FORBIDDEN);
    request["userId"] = json!(owner.id);
    request["operation"] = json!("_deskfleet/input/submit");
    assert_eq!(
        call!(&credential, &request).status(),
        StatusCode::BAD_REQUEST
    );
    request["operation"] = json!("session");

    // The ordinary user RPC endpoint cannot impersonate this internal route.
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!(
                "/api/teams/{}/machines/{}/rpc",
                a.id, target_a.machine_id
            ))
            .insert_header((
                "Authorization",
                format!("Bearer {}", login["token"].as_str().unwrap()),
            ))
            .set_json(json!({"method":"remoteMcp","params":{}}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    consent.store(false, Ordering::SeqCst);
    assert_eq!(call!(&credential, &request).status(), StatusCode::FORBIDDEN);
    state
        .store
        .revoke_machine(&owner.id, &source.id)
        .await
        .unwrap();
    assert_eq!(
        call!(&credential, &request).status(),
        StatusCode::UNAUTHORIZED
    );
    for worker in [worker_a, worker_b, worker_denied] {
        worker.abort();
    }
}
