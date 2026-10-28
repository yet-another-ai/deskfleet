//! Routing between independent API instances backed by one PostgreSQL database.
use crate::{AppState, config::ServerConfig, error::ApiError};
use actix_web::http::StatusCode;
use deskfleet_protocol::control::{
    ControlMessage, Machine, PeerActor, PeerAuthorization, PeerTarget,
};
use serde_json::json;
use std::time::Duration;
use tokio::sync::{mpsc, watch};

const WAIT: Duration = Duration::from_secs(5);

struct Fixture {
    source: AppState,
    target: AppState,
    machine: Machine,
    actor: PeerActor,
    login_id: String,
}

impl Fixture {
    async fn new() -> Self {
        async fn state() -> AppState {
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
            .unwrap()
        }

        let source = state().await;
        let target = state().await;
        let user = source
            .store
            .verified_user(
                &format!("routing-{}@fixture.test", uuid::Uuid::new_v4()),
                "Owner",
            )
            .await
            .unwrap();
        let team = source.store.create_team(&user.id, "Routing").await.unwrap();
        let (machine, _) = source
            .store
            .enroll(
                &user.id,
                &team.id,
                "Remote",
                &uuid::Uuid::new_v4().to_string(),
                "1",
                json!({}),
            )
            .await
            .unwrap();
        let login = source.store.new_session(&user.id).await.unwrap();
        let login_id = login["sessionId"].as_str().unwrap().to_owned();
        let actor = PeerActor {
            kind: "user".into(),
            user_id: user.id,
            device_id: login_id.clone(),
            source_machine: Some(json!({"id":"initiator"})),
        };
        Self {
            source,
            target,
            machine,
            actor,
            login_id,
        }
    }

    fn peer(&self) -> PeerAuthorization {
        PeerAuthorization {
            peer_id: uuid::Uuid::new_v4().to_string(),
            server_id: self.source.config.public_url.clone(),
            team_id: self.machine.team_id.clone(),
            actor: self.actor.clone(),
            target_machine: PeerTarget {
                id: self.machine.id.clone(),
                origin_id: self.machine.origin_id.clone(),
                local_machine_id: self.machine.local_machine_id.clone(),
            },
            purpose: "agent".into(),
            actions: vec!["agent:read".into()],
            issued_at: deskfleet_control_store::timestamp(deskfleet_control_store::now_ms()),
            expires_at: deskfleet_control_store::timestamp(
                deskfleet_control_store::now_ms() + 60_000,
            ),
        }
    }

    async fn close(self) {
        let source = self.source.store.clone();
        let target = self.target.store.clone();
        drop(self);
        source.close().await.unwrap();
        target.close().await.unwrap();
    }
}

struct Socket {
    messages: mpsc::Receiver<ControlMessage>,
    shutdown: watch::Receiver<Option<u16>>,
}

impl Socket {
    async fn daemon(state: &AppState, machine_id: &str, connection_id: &str) -> Self {
        let (sender, messages) = mpsc::channel(16);
        let (shutdown, stopped) = watch::channel(None);
        state
            .hub
            .add_daemon(machine_id, connection_id, sender, shutdown)
            .await
            .unwrap();
        Self {
            messages,
            shutdown: stopped,
        }
    }

    async fn client(state: &AppState, login_id: &str, user_id: &str) -> Self {
        let (sender, messages) = mpsc::channel(16);
        let (shutdown, stopped) = watch::channel(None);
        state
            .hub
            .add_client(
                login_id,
                user_id,
                &uuid::Uuid::new_v4().to_string(),
                sender,
                shutdown,
            )
            .await
            .unwrap();
        Self {
            messages,
            shutdown: stopped,
        }
    }

    async fn next(&mut self) -> ControlMessage {
        tokio::time::timeout(WAIT, self.messages.recv())
            .await
            .expect("cross-instance message arrives")
            .expect("socket stays open")
    }

    async fn stopped(&mut self) -> u16 {
        tokio::time::timeout(WAIT, self.shutdown.wait_for(Option::is_some))
            .await
            .expect("cross-instance shutdown arrives")
            .expect("shutdown sender stays open")
            .expect("shutdown code")
    }
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_remote_rpc_preserves_actor_success_and_structured_failure() {
    let fixture = Fixture::new().await;
    let mut daemon = Socket::daemon(&fixture.target, &fixture.machine.id, "remote").await;
    assert!(fixture.source.hub.online(&fixture.machine.id).await);

    for failing in [false, true] {
        let request = fixture.source.hub.request(
            &fixture.machine.id,
            "desktop.start",
            json!({"displayId":2}),
            Some(fixture.actor.clone()),
        );
        tokio::pin!(request);
        let request_id = tokio::select! {
            result = &mut request => panic!("RPC completed before daemon response: {result:?}"),
            message = daemon.next() => match message {
                ControlMessage::Request { id, method, params, actor } => {
                    assert_eq!(method, "desktop.start");
                    assert_eq!(params, json!({"displayId":2}));
                    assert_eq!(serde_json::to_value(actor).unwrap(), serde_json::to_value(&fixture.actor).unwrap());
                    id
                }
                message => panic!("unexpected daemon message: {message:?}"),
            },
        };
        let response = if failing {
            let mut error = ApiError::new(
                StatusCode::BAD_GATEWAY,
                "daemon_error",
                "encoder rejected the display",
            );
            error.reason = Some("encoder".into());
            Err(error)
        } else {
            Ok(json!({"started":true,"codec":"h264"}))
        };
        fixture
            .target
            .hub
            .response(&fixture.machine.id, "remote", &request_id, response)
            .await;
        let result = tokio::time::timeout(WAIT, request)
            .await
            .expect("response reaches requesting instance");
        if failing {
            let error = result.unwrap_err();
            assert_eq!(error.status, StatusCode::BAD_GATEWAY);
            assert_eq!(error.code, "daemon_error");
            assert_eq!(error.message, "encoder rejected the display");
            assert_eq!(error.reason.as_deref(), Some("encoder"));
        } else {
            assert_eq!(result.unwrap(), json!({"started":true,"codec":"h264"}));
        }
    }
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_remote_notifications_revocations_and_disconnects_keep_recipient_scope() {
    let fixture = Fixture::new().await;
    let mut daemon = Socket::daemon(&fixture.target, &fixture.machine.id, "remote").await;
    let mut local =
        Socket::client(&fixture.source, &fixture.login_id, &fixture.actor.user_id).await;
    let mut remote =
        Socket::client(&fixture.target, &fixture.login_id, &fixture.actor.user_id).await;
    let mut other_login =
        Socket::client(&fixture.target, "other-login", &fixture.actor.user_id).await;
    let mut outsider = Socket::client(&fixture.target, "outside-login", "outside-user").await;

    fixture
        .source
        .hub
        .send_client(&fixture.login_id, ControlMessage::Ping)
        .await
        .unwrap();
    assert!(matches!(local.next().await, ControlMessage::Ping));
    assert!(matches!(remote.next().await, ControlMessage::Ping));
    fixture
        .source
        .hub
        .notify_users(
            std::slice::from_ref(&fixture.actor.user_id),
            ControlMessage::MachinesChanged {
                team_id: fixture.machine.team_id.clone(),
            },
        )
        .await
        .unwrap();
    for socket in [&mut local, &mut remote, &mut other_login] {
        assert!(
            matches!(socket.next().await, ControlMessage::MachinesChanged { team_id } if team_id == fixture.machine.team_id)
        );
    }

    let peer = fixture.peer();
    fixture
        .source
        .hub
        .revoke(vec![peer.clone()], "logout")
        .await
        .unwrap();
    for socket in [&mut daemon, &mut local, &mut remote, &mut other_login] {
        assert!(
            matches!(socket.next().await, ControlMessage::PeerRevoked { peer_id, reason } if peer_id == peer.peer_id && reason == "logout")
        );
    }
    assert!(outsider.messages.try_recv().is_err());
    assert_eq!(*outsider.shutdown.borrow(), None);

    fixture
        .source
        .hub
        .disconnect_login(&fixture.login_id)
        .await
        .unwrap();
    assert_eq!(local.stopped().await, 4401);
    assert_eq!(remote.stopped().await, 4401);
    assert_eq!(*other_login.shutdown.borrow(), None);
    fixture
        .source
        .hub
        .disconnect_user(&fixture.actor.user_id)
        .await
        .unwrap();
    assert_eq!(other_login.stopped().await, 4401);
    assert_eq!(*outsider.shutdown.borrow(), None);
    fixture
        .source
        .hub
        .disconnect_machine(&fixture.machine.id)
        .await
        .unwrap();
    assert_eq!(daemon.stopped().await, 4403);
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_replaced_daemon_cannot_reply_to_or_remove_current_connection() {
    let fixture = Fixture::new().await;
    let mut old = Socket::daemon(&fixture.source, &fixture.machine.id, "old").await;
    let mut replacement;
    {
        let pending =
            fixture
                .source
                .hub
                .request(&fixture.machine.id, "catalog.list", json!({}), None);
        tokio::pin!(pending);
        tokio::select! {
            result = &mut pending => panic!("RPC completed before daemon response: {result:?}"),
            message = old.next() => assert!(matches!(message, ControlMessage::Request { .. })),
        }
        replacement = Socket::daemon(&fixture.target, &fixture.machine.id, "replacement").await;
        assert_eq!(old.stopped().await, 1012);
        let error = tokio::time::timeout(WAIT, pending)
            .await
            .expect("replacement releases the old connection's pending RPC")
            .unwrap_err();
        assert_eq!(error.code, "machine_offline");
    }
    assert!(
        !fixture
            .source
            .hub
            .is_current(&fixture.machine.id, "old")
            .await
    );
    assert!(
        !fixture
            .source
            .hub
            .remove_daemon(&fixture.machine.id, "old")
            .await
    );
    assert!(fixture.source.hub.online(&fixture.machine.id).await);

    {
        let request =
            fixture
                .source
                .hub
                .request(&fixture.machine.id, "catalog.list", json!({}), None);
        tokio::pin!(request);
        let request_id = tokio::select! {
            result = &mut request => panic!("RPC completed before daemon response: {result:?}"),
            message = replacement.next() => match message {
                ControlMessage::Request { id, .. } => id,
                message => panic!("unexpected daemon message: {message:?}"),
            },
        };
        fixture
            .source
            .hub
            .response(
                &fixture.machine.id,
                "old",
                &request_id,
                Ok(json!({"source":"old"})),
            )
            .await;
        fixture
            .target
            .hub
            .response(
                &fixture.machine.id,
                "replacement",
                &request_id,
                Ok(json!({"source":"replacement"})),
            )
            .await;
        assert_eq!(
            tokio::time::timeout(WAIT, request).await.unwrap().unwrap(),
            json!({"source":"replacement"})
        );
    }
    assert!(old.messages.try_recv().is_err());
    assert!(
        fixture
            .target
            .hub
            .remove_daemon(&fixture.machine.id, "replacement")
            .await
    );
    assert!(!fixture.source.hub.online(&fixture.machine.id).await);
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_database_failure_does_not_fall_back_to_local_daemon_authority() {
    let fixture = Fixture::new().await;
    let mut daemon = Socket::daemon(&fixture.source, &fixture.machine.id, "local").await;
    fixture.source.store.close().await.unwrap();

    assert!(!fixture.source.hub.online(&fixture.machine.id).await);
    assert!(
        !fixture
            .source
            .hub
            .is_current(&fixture.machine.id, "local")
            .await
    );
    assert!(
        fixture
            .source
            .hub
            .request(&fixture.machine.id, "catalog.list", json!({}), None)
            .await
            .is_err()
    );
    assert!(daemon.messages.try_recv().is_err());
    assert_eq!(daemon.stopped().await, 1012);
    fixture.close().await;
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_enrollment_returns_credential_when_routing_notification_fails() {
    use actix_web::{App, test, web};

    let mut fixture = Fixture::new().await;
    // Enrollment storage stays healthy while this Hub's independent pool fails.
    fixture.source.hub = fixture.target.hub.clone();
    let mut roster =
        Socket::client(&fixture.source, &fixture.login_id, &fixture.actor.user_id).await;
    fixture.target.store.close().await.unwrap();
    let login = fixture
        .source
        .store
        .new_session(&fixture.actor.user_id)
        .await
        .unwrap();
    let store = fixture.source.store.clone();
    let state = web::Data::new(fixture.source);
    let app = test::init_service(
        App::new()
            .app_data(state.clone())
            .configure(crate::configure),
    )
    .await;
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/api/teams/{}/machines", fixture.machine.team_id))
            .insert_header((
                "Authorization",
                format!("Bearer {}", login["token"].as_str().unwrap()),
            ))
            .set_json(json!({
                "name": "New machine", "originId": uuid::Uuid::new_v4().to_string(),
                "localMachineId": "1",
            }))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let enrollment: serde_json::Value = test::read_body_json(response).await;
    let machine = store
        .authenticate_machine(enrollment["token"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        machine.machine.id,
        enrollment["machine"]["id"].as_str().unwrap()
    );
    assert_eq!(machine.machine.team_id, fixture.machine.team_id);
    assert_eq!(roster.stopped().await, 1012);
    assert!(roster.messages.try_recv().is_err());
    drop(app);
    drop(state);
    drop(fixture.target);
    store.close().await.unwrap();
}
