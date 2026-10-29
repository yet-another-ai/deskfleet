//! Real-PostgreSQL regressions for signaling across independent API instances.

use super::*;
use crate::{config::ServerConfig, peers};
use actix_web::{http::StatusCode, test};
use deskfleet_control_store::{PeerCandidateState, PeerOfferState, now_ms};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use tokio::sync::{mpsc, watch};

#[path = "local_tests.rs"]
mod local_tests;

struct Fixture {
    admin: DatabaseConnection,
    schema: String,
    a: web::Data<AppState>,
    b: web::Data<AppState>,
    machine: String,
    team: String,
    token: String,
    login: String,
    requests: mpsc::Receiver<ControlMessage>,
    events: mpsc::Receiver<ControlMessage>,
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
        let admin = Database::connect(&url).await.unwrap();
        // Fault-injection triggers must not affect concurrently running cases.
        // Both API instances still share this test's database tables and inboxes.
        let schema = format!("signaling_test_{}", uuid::Uuid::new_v4().simple());
        admin
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let config = ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: format!("{url}{separator}options=-csearch_path%3D{schema}"),
            public_url: "https://shared-control.test".into(),
            web_origins: vec![],
            auth: crate::auth::config::AuthConfig::development("https://shared-control.test"),
            billing: Default::default(),
            stun_urls: vec![],
            turn_urls: vec![],
            turn_secret: None,
            turn_usage_redis_url: None,
        };
        let a = web::Data::new(AppState::new(config.clone()).await.unwrap());
        let b = web::Data::new(AppState::new(config).await.unwrap());
        let user = a
            .store
            .verified_user(
                &format!("shared-{}@fixture.test", uuid::Uuid::new_v4()),
                "Owner",
            )
            .await
            .unwrap();
        let team = a
            .store
            .create_team(&user.id, "Shared signaling")
            .await
            .unwrap();
        let (machine, _) = a
            .store
            .enroll(
                &user.id,
                &team.id,
                "Remote daemon",
                &uuid::Uuid::new_v4().to_string(),
                "1",
                json!({}),
            )
            .await
            .unwrap();
        let session = a.store.new_session(&user.id).await.unwrap();
        let token = session["token"].as_str().unwrap().to_owned();
        let login = a.store.authenticate(&token).await.unwrap().id;
        let (send, requests) = mpsc::channel(64);
        let (shutdown, _shutdown) = watch::channel(None);
        b.hub
            .add_daemon(&machine.id, "daemon-b", send, shutdown)
            .await
            .unwrap();
        let (send, events) = mpsc::channel(64);
        let (shutdown, _shutdown) = watch::channel(None);
        a.hub
            .add_client(&login, &user.id, "client-a", send, shutdown)
            .await
            .unwrap();
        Self {
            admin,
            schema,
            a,
            b,
            machine: machine.id,
            team: team.id,
            token,
            login,
            requests,
            events,
        }
    }

    async fn peer(&self) -> String {
        let response = peers::create(
            request(&self.token),
            self.a.clone(),
            web::Json(peers::Create {
                team_id: self.team.clone(),
                machine_id: self.machine.clone(),
                purpose: "agent".into(),
            }),
        )
        .await
        .unwrap();
        response["peerId"].as_str().unwrap().into()
    }

    async fn response(&self, id: &str, value: Value) {
        self.b
            .hub
            .response(&self.machine, "daemon-b", id, Ok(value))
            .await;
    }

    async fn next_request(&mut self, method: &str) -> (String, Value) {
        let message = tokio::time::timeout(Duration::from_secs(5), self.requests.recv())
            .await
            .expect("request must reach the daemon on instance B")
            .unwrap();
        match message {
            ControlMessage::Request {
                id,
                method: actual,
                params,
                ..
            } => {
                assert_eq!(actual, method);
                (id, params)
            }
            _ => panic!("unexpected daemon message: {message:?}"),
        }
    }

    async fn close(self) {
        self.b.hub.remove_daemon(&self.machine, "daemon-b").await;
        self.a.hub.remove_client(&self.login, "client-a").await;
        let a = self.a.store.clone();
        let b = self.b.store.clone();
        drop(self.a);
        drop(self.b);
        a.close().await.unwrap();
        b.close().await.unwrap();
        self.admin
            .execute_unprepared(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
        self.admin.close().await.unwrap();
    }
}

fn request(token: &str) -> HttpRequest {
    test::TestRequest::default()
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_http_request()
}

fn candidate_value(port: u16) -> Value {
    json!({"candidate":format!("candidate:1 1 UDP 1 127.0.0.1 {port} typ host"),"sdpMlineIndex":0})
}

fn start_offer(
    state: web::Data<AppState>,
    token: String,
    peer: String,
    sdp: String,
) -> tokio::task::JoinHandle<Result<web::Json<Value>>> {
    actix_web::rt::spawn(async move {
        offer(
            request(&token),
            state,
            peer.into(),
            web::Json(Offer {
                sdp,
                options: Value::Null,
            }),
        )
        .await
    })
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn shared_offer_candidates_and_daemon_ice_cross_instances() {
    let mut fixture = Fixture::new().await;
    let peer = fixture.peer().await;
    let sdp = peers::tests::sdp();
    let answer = sdp.replace("ice-ufrag:one", "ice-ufrag:two");
    // B receives a candidate before A receives the offer.
    candidate(
        request(&fixture.token),
        fixture.b.clone(),
        peer.clone().into(),
        web::Json(Candidate {
            candidate: candidate_value(10_001),
        }),
    )
    .await
    .unwrap();
    let first = start_offer(
        fixture.a.clone(),
        fixture.token.clone(),
        peer.clone(),
        sdp.clone(),
    );
    let (offer_id, params) = fixture.next_request("peer.offer").await;
    assert_eq!(params["sdp"], sdp);
    let repeated = start_offer(
        fixture.b.clone(),
        fixture.token.clone(),
        peer.clone(),
        sdp.clone(),
    );
    let mismatch = offer(
        request(&fixture.token),
        fixture.b.clone(),
        peer.clone().into(),
        web::Json(Offer {
            sdp: sdp.clone(),
            options: json!({"different":true}),
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(mismatch.status, StatusCode::BAD_REQUEST);
    // A receives another candidate while the daemon is still making its answer.
    candidate(
        request(&fixture.token),
        fixture.a.clone(),
        peer.clone().into(),
        web::Json(Candidate {
            candidate: candidate_value(10_002),
        }),
    )
    .await
    .unwrap();
    assert!(fixture.requests.try_recv().is_err());
    let state = fixture.b.clone();
    let machine = fixture.machine.clone();
    let event_peer = peer.clone();
    let early_ice = actix_web::rt::spawn(async move {
        daemon_event(
            &state,
            &machine,
            "daemon-b",
            event_peer,
            json!({"kind":"iceCandidate","candidate":candidate_value(10_003)}),
        )
        .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(30), fixture.events.recv())
            .await
            .is_err()
    );
    assert!(!first.is_finished() && !repeated.is_finished() && !early_ice.is_finished());
    fixture.response(&offer_id, json!({"sdp":answer})).await;
    for port in [10_001, 10_002] {
        let (id, params) = fixture.next_request("peer.candidate").await;
        assert_eq!(params["candidate"]["usernameFragment"], "one");
        assert!(
            params["candidate"]["candidate"]
                .as_str()
                .unwrap()
                .contains(&port.to_string())
        );
        fixture.response(&id, json!({})).await;
    }
    assert_eq!(first.await.unwrap().unwrap()["sdp"], answer);
    assert_eq!(repeated.await.unwrap().unwrap()["sdp"], answer);
    early_ice.await.unwrap().unwrap();
    let event = tokio::time::timeout(Duration::from_secs(5), fixture.events.recv())
        .await
        .unwrap()
        .unwrap();
    let ControlMessage::PeerEvent { event, .. } = event else {
        panic!("expected ICE event")
    };
    assert_eq!(event["candidate"]["usernameFragment"], "two");
    assert_eq!(event["candidate"]["sdpMid"], "data");
    assert!(
        fixture.requests.try_recv().is_err(),
        "duplicate offers must not reach the daemon"
    );
    fixture.a.store.prune_realtime().await.unwrap();
    assert_eq!(
        fixture.b.store.peer_answer(&peer).await.unwrap(),
        Some(answer)
    );
    let state = fixture.a.clone();
    let token = fixture.token.clone();
    let candidate_peer = peer.clone();
    let sending = actix_web::rt::spawn(async move {
        candidate(
            request(&token),
            state,
            candidate_peer.into(),
            web::Json(Candidate {
                candidate: candidate_value(10_007),
            }),
        )
        .await
    });
    let (id, params) = fixture.next_request("peer.candidate").await;
    assert_eq!(params["candidate"]["usernameFragment"], "one");
    fixture.response(&id, json!({})).await;
    sending.await.unwrap().unwrap();
    fixture.close().await;
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn closing_shared_peer_during_offer_prevents_answer_and_ice_publication() {
    let mut fixture = Fixture::new().await;
    let peer = fixture.peer().await;
    let sdp = peers::tests::sdp();
    let offering = start_offer(
        fixture.a.clone(),
        fixture.token.clone(),
        peer.clone(),
        sdp.clone(),
    );
    let (id, _) = fixture.next_request("peer.offer").await;
    let state = fixture.b.clone();
    let machine = fixture.machine.clone();
    let event_peer = peer.clone();
    let early_ice = actix_web::rt::spawn(async move {
        daemon_event(
            &state,
            &machine,
            "daemon-b",
            event_peer,
            json!({"kind":"iceCandidate","candidate":candidate_value(10_004)}),
        )
        .await
    });
    peers::close(
        request(&fixture.token),
        fixture.b.clone(),
        peer.clone().into(),
    )
    .await
    .unwrap();
    fixture.response(&id, json!({"sdp":sdp})).await;
    assert!(offering.await.unwrap().is_err());
    assert!(early_ice.await.unwrap().is_err());
    assert!(fixture.a.store.peer_answer(&peer).await.is_err());
    while let Ok(event) = fixture.events.try_recv() {
        assert!(!matches!(event, ControlMessage::PeerEvent { .. }));
    }
    fixture.a.store.prune_realtime().await.unwrap();
    assert_negotiation_absent(&fixture, &peer).await;
    fixture.close().await;
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn shared_negotiation_bounds_candidates_and_never_replays_expired_offer() {
    let mut fixture = Fixture::new().await;
    let peer = fixture.peer().await;
    for _ in 0..256 {
        assert_eq!(
            fixture
                .a
                .store
                .queue_peer_candidate(&peer, &candidate_value(10_005))
                .await
                .unwrap(),
            PeerCandidateState::Queued
        );
    }
    assert!(
        fixture
            .b
            .store
            .queue_peer_candidate(&peer, &candidate_value(10_006))
            .await
            .is_err()
    );
    let sdp = peers::tests::sdp();
    assert_eq!(
        fixture
            .a
            .store
            .prepare_peer_offer(&peer, &sdp, &Value::Null)
            .await
            .unwrap(),
        PeerOfferState::Start
    );
    assert_eq!(
        fixture
            .b
            .store
            .prepare_peer_offer(&peer, &sdp, &Value::Null)
            .await
            .unwrap(),
        PeerOfferState::Waiting
    );
    let changed = sdp.replace("ice-ufrag:one", "ice-ufrag:other");
    assert!(
        fixture
            .b
            .store
            .prepare_peer_offer(&peer, &changed, &Value::Null)
            .await
            .is_err()
    );
    fixture
        .a
        .store
        .database()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE cp_peer_negotiations SET started_at=$2 WHERE peer_id=$1",
            vec![peer.clone().into(), (now_ms() - 60_001).into()],
        ))
        .await
        .unwrap();
    // Simulates the request owner dying after sending its offer. Another instance
    // rejects that attempt instead of replaying a side effect with unknown outcome.
    let failure = offer(
        request(&fixture.token),
        fixture.b.clone(),
        peer.clone().into(),
        web::Json(Offer {
            sdp,
            options: Value::Null,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(failure.status, StatusCode::BAD_REQUEST);
    assert!(fixture.a.store.peer(&peer, &fixture.login).await.is_err());
    let message = tokio::time::timeout(Duration::from_secs(5), fixture.requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(message, ControlMessage::PeerRevoked { .. }),
        "the stale offer must never reach the daemon"
    );
    let expired = fixture.peer().await;
    fixture
        .a
        .store
        .queue_peer_candidate(&expired, &candidate_value(10_008))
        .await
        .unwrap();
    fixture
        .a
        .store
        .database()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE cp_peers SET expires_at=$2 WHERE id=$1",
            vec![expired.clone().into(), (now_ms() - 1).into()],
        ))
        .await
        .unwrap();
    fixture.a.store.prune_realtime().await.unwrap();
    assert_negotiation_absent(&fixture, &peer).await;
    assert_negotiation_absent(&fixture, &expired).await;
    fixture.close().await;
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn post_answer_ice_forwarding_failure_keeps_shared_negotiation() {
    let mut fixture = Fixture::new().await;
    let peer = fixture.peer().await;
    let sdp = peers::tests::sdp();
    let answer = sdp.replace("ice-ufrag:one", "ice-ufrag:two");
    // Buffered before the answer; normalization fails only while forwarding.
    candidate(
        request(&fixture.token),
        fixture.a.clone(),
        peer.clone().into(),
        web::Json(Candidate {
            candidate: json!({
                "candidate":"candidate:1 1 UDP 1 127.0.0.1 10009 typ host",
                "sdpMlineIndex":99
            }),
        }),
    )
    .await
    .unwrap();
    let starter = start_offer(
        fixture.a.clone(),
        fixture.token.clone(),
        peer.clone(),
        sdp.clone(),
    );
    let (id, _) = fixture.next_request("peer.offer").await;
    let waiter = start_offer(
        fixture.b.clone(),
        fixture.token.clone(),
        peer.clone(),
        sdp.clone(),
    );
    fixture.response(&id, json!({"sdp":answer})).await;
    assert_eq!(starter.await.unwrap().unwrap()["sdp"], answer);
    assert_eq!(waiter.await.unwrap().unwrap()["sdp"], answer);
    assert_eq!(
        fixture.a.store.peer_answer(&peer).await.unwrap(),
        Some(answer.clone())
    );
    assert!(fixture.a.store.peer(&peer, &fixture.login).await.is_ok());
    assert!(!fixture.a.store.fail_peer_offer(&peer).await.unwrap());
    assert_eq!(
        fixture.b.store.peer_answer(&peer).await.unwrap(),
        Some(answer)
    );
    fixture.close().await;
}

#[actix_web::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn closed_peer_revokes_grant_when_client_notify_fails() {
    let fixture = Fixture::new().await;
    let peer = fixture.peer().await;
    fixture
        .b
        .store
        .database()
        .execute_unprepared(
            "CREATE FUNCTION reject_realtime_messages() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected notify failure'; END; $$ LANGUAGE plpgsql",
        )
        .await
        .unwrap();
    fixture
        .b
        .store
        .database()
        .execute_unprepared(
            "CREATE TRIGGER reject_realtime_messages BEFORE INSERT ON cp_realtime_messages FOR EACH ROW EXECUTE FUNCTION reject_realtime_messages()",
        )
        .await
        .unwrap();
    let result = daemon_event(
        &fixture.b,
        &fixture.machine,
        "daemon-b",
        peer.clone(),
        json!({"kind":"stateChanged","state":"closed"}),
    )
    .await;
    let _ = fixture
        .b
        .store
        .database()
        .execute_unprepared(
            "DROP TRIGGER IF EXISTS reject_realtime_messages ON cp_realtime_messages",
        )
        .await;
    let _ = fixture
        .b
        .store
        .database()
        .execute_unprepared("DROP FUNCTION IF EXISTS reject_realtime_messages()")
        .await;
    assert!(result.is_err());
    assert!(fixture.a.store.peer(&peer, &fixture.login).await.is_err());
    assert!(
        fixture
            .a
            .store
            .valid_machine_peers(&fixture.machine)
            .await
            .unwrap()
            .is_empty()
    );
    fixture.close().await;
}

async fn assert_negotiation_absent(fixture: &Fixture, peer_id: &str) {
    assert!(
        fixture
            .a
            .store
            .database()
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT peer_id FROM cp_peer_negotiations WHERE peer_id=$1",
                vec![peer_id.into()],
            ))
            .await
            .unwrap()
            .is_none()
    );
}
