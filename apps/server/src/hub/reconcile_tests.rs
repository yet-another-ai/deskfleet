//! Reconcile missed revocations without allowing a stale snapshot to close a new peer.
use super::*;
use deskfleet_protocol::control::{PeerActor, PeerTarget};
use sea_orm::{ConnectionTrait, Database, TransactionTrait};
use serde_json::json;

const WAIT: Duration = Duration::from_secs(5);

#[tokio::test]
async fn daemon_requests_wait_for_the_reconciliation_gate() {
    let hub = Hub::default();
    let (send, mut messages) = mpsc::channel(1);
    let (shutdown, _stopped) = watch::channel(None);
    hub.add_daemon("machine", "socket", send, shutdown)
        .await
        .unwrap();
    let gate = hub.registration.lock().await;
    let request = hub.send_request("machine", "socket", ControlMessage::Ping);
    tokio::pin!(request);
    assert!(futures_util::poll!(&mut request).is_pending());
    assert!(messages.try_recv().is_err());
    drop(gate);
    request.await.unwrap();
    assert!(matches!(messages.recv().await, Some(ControlMessage::Ping)));
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_reconciliation_repairs_missed_revocation_and_precedes_new_offers() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let admin = Database::connect(&url).await.unwrap();
    let schema = format!("reconcile_test_{}", uuid::Uuid::new_v4().simple());
    admin
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let store = ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
        .await
        .unwrap();
    let user = store
        .verified_user("owner@fixture.test", "Owner")
        .await
        .unwrap();
    let team = store.create_team(&user.id, "Reconcile").await.unwrap();
    let (machine, _) = store
        .enroll(
            &user.id,
            &team.id,
            "Machine",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    let login = store.new_session(&user.id).await.unwrap();
    let login = login["sessionId"].as_str().unwrap();
    let expires = deskfleet_control_store::now_ms() + 60_000;
    let grant = |id: &str| PeerAuthorization {
        peer_id: id.into(),
        server_id: "server".into(),
        team_id: team.id.clone(),
        actor: PeerActor {
            kind: "user".into(),
            user_id: user.id.clone(),
            device_id: login.into(),
            source_machine: None,
        },
        target_machine: PeerTarget {
            id: machine.id.clone(),
            origin_id: machine.origin_id.clone(),
            local_machine_id: machine.local_machine_id.clone(),
        },
        purpose: "agent".into(),
        actions: vec!["agent:read".into()],
        issued_at: deskfleet_control_store::timestamp(deskfleet_control_store::now_ms()),
        expires_at: deskfleet_control_store::timestamp(expires),
    };
    store
        .save_peer(&grant("active"), login, expires)
        .await
        .unwrap();
    store
        .save_peer(&grant("revoked"), login, expires)
        .await
        .unwrap();
    let (hub, router) = Hub::connect(store.clone()).await.unwrap();
    let (send, mut messages) = mpsc::channel(16);
    let (shutdown, _stopped) = watch::channel(None);
    hub.add_daemon(&machine.id, "socket", send, shutdown)
        .await
        .unwrap();

    hub.reconcile_daemon(&machine.id, "socket").await.unwrap();
    assert_eq!(
        peer_ids(messages.recv().await.unwrap()),
        ["active", "revoked"]
    );
    // The database commit succeeds but its immediate broadcast never happens.
    store.revoke_peer("revoked").await.unwrap();
    for _heartbeat in 0..2 {
        hub.reconcile_daemon(&machine.id, "socket").await.unwrap();
        assert_eq!(peer_ids(messages.recv().await.unwrap()), ["active"]);
    }

    // Pause the current-route check after the snapshot has been read. A new
    // grant can commit meanwhile, but its offer must follow that older snapshot.
    let lock = store.database().begin().await.unwrap();
    lock.execute_unprepared("LOCK TABLE cp_realtime_routes IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let reconciling = {
        let hub = hub.clone();
        let machine = machine.id.clone();
        tokio::spawn(async move { hub.reconcile_daemon(&machine, "socket").await })
    };
    tokio::time::timeout(WAIT, async {
        loop {
            let waiting = store.database().query_one_raw(sea_orm::Statement::from_string(
                sea_orm::DbBackend::Postgres,
                "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation='cp_realtime_routes'::regclass AND mode='AccessShareLock' AND NOT granted) AS waiting",
            )).await.unwrap().unwrap().try_get::<bool>("", "waiting").unwrap();
            if waiting {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reconciliation reads its snapshot before checking the blocked route");
    store
        .save_peer(&grant("new"), login, expires)
        .await
        .unwrap();
    let offering = {
        let hub = hub.clone();
        let machine = machine.id.clone();
        tokio::spawn(async move {
            hub.send_request(
                &machine,
                "socket",
                ControlMessage::Request {
                    id: "offer".into(),
                    method: "peer.offer".into(),
                    params: json!({"peerId":"new"}),
                    actor: None,
                },
            )
            .await
        })
    };
    lock.commit().await.unwrap();
    tokio::time::timeout(WAIT, async {
        reconciling.await.unwrap().unwrap();
        offering.await.unwrap().unwrap();
    })
    .await
    .unwrap();
    assert_eq!(peer_ids(messages.recv().await.unwrap()), ["active"]);
    assert!(
        matches!(messages.recv().await.unwrap(), ControlMessage::Request { id, .. } if id == "offer")
    );
    hub.reconcile_daemon(&machine.id, "socket").await.unwrap();
    assert_eq!(peer_ids(messages.recv().await.unwrap()), ["active", "new"]);

    let (send, mut replacement) = mpsc::channel(16);
    let (shutdown, _stopped) = watch::channel(None);
    hub.add_daemon(&machine.id, "replacement", send, shutdown)
        .await
        .unwrap();
    assert!(hub.reconcile_daemon(&machine.id, "socket").await.is_err());
    assert!(replacement.try_recv().is_err());
    hub.reconcile_daemon(&machine.id, "replacement")
        .await
        .unwrap();
    assert_eq!(
        peer_ids(replacement.recv().await.unwrap()),
        ["active", "new"]
    );

    drop(router);
    store.close().await.unwrap();
    admin
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    admin.close().await.unwrap();
}

fn peer_ids(message: ControlMessage) -> Vec<String> {
    let ControlMessage::ReconcilePeers { peers } = message else {
        panic!("expected reconciliation, got {message:?}");
    };
    let mut peers: Vec<_> = peers.into_iter().map(|peer| peer.peer_id).collect();
    peers.sort();
    peers
}
