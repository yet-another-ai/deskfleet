//! Requires a real PostgreSQL TEST_DATABASE_URL; run with --ignored.
use deskfleet_control_store::{
    AuthSession, ControlStore, Error, TurnUsage, TurnUsageSide, now_ms, timestamp,
};
use deskfleet_protocol::control::{PeerActor, PeerAuthorization, PeerTarget};
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::json;

async fn peer(store: &ControlStore, auth: &AuthSession, expires: i64) -> PeerAuthorization {
    let team = store
        .create_team(&auth.user.id, "TURN fixture")
        .await
        .unwrap();
    let (machine, _) = store
        .enroll(
            &auth.user.id,
            &team.id,
            "TURN fixture",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    let peer = PeerAuthorization {
        peer_id: uuid::Uuid::new_v4().to_string(),
        server_id: "https://control.test".into(),
        team_id: team.id,
        actor: PeerActor {
            kind: "user".into(),
            user_id: auth.user.id.clone(),
            device_id: auth.device_id.clone(),
            source_machine: None,
        },
        target_machine: PeerTarget {
            id: machine.id,
            origin_id: machine.origin_id,
            local_machine_id: "1".into(),
        },
        purpose: "agent".into(),
        actions: vec!["agent:read".into()],
        issued_at: timestamp(now_ms() - 2000),
        expires_at: timestamp(expires),
    };
    store.save_peer(&peer, &auth.id, expires).await.unwrap();
    peer
}

async fn totals(store: &ControlStore, team: &str, side: &str) -> (i64, i64, i64) {
    let row = store
        .database()
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT COUNT(*) AS events, COALESCE(SUM(received_bytes),0)::bigint AS received, COALESCE(SUM(sent_bytes),0)::bigint AS sent FROM cp_turn_usage WHERE team_id=$1 AND side=$2",
            vec![team.parse::<i64>().unwrap().into(), side.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    (
        row.try_get("", "events").unwrap(),
        row.try_get("", "received").unwrap(),
        row.try_get("", "sent").unwrap(),
    )
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_turn_usage_attributes_teams_and_counts_each_delta() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL to PostgreSQL");
    let store = ControlStore::connect(&url).await.unwrap();
    let user = store
        .oidc_user(
            &format!("https://turn-fixture/{}", uuid::Uuid::new_v4()),
            "owner",
            "Owner",
            None,
            false,
        )
        .await
        .unwrap();
    let session = store.new_session(&user.id).await.unwrap();
    let auth = store
        .authenticate(session["token"].as_str().unwrap())
        .await
        .unwrap();
    let first = peer(&store, &auth, now_ms() + 60_000).await;
    let expired = peer(&store, &auth, now_ms() - 1000).await;
    assert_eq!(
        store.team_usage(&user.id, &first.team_id).await.unwrap()["relayedBytes"],
        "0"
    );
    let event = TurnUsage {
        peer_id: first.peer_id.clone(),
        realm: "turn.test".into(),
        allocation_id: "000000000000000001".into(),
        side: TurnUsageSide::Client,
        received_bytes: 10,
        sent_bytes: 20,
        collected_at: now_ms(),
    };
    assert!(store.record_turn_usage(&event).await.unwrap());
    // Separate notifications can carry identical interval deltas.
    assert!(store.record_turn_usage(&event).await.unwrap());
    assert_eq!(totals(&store, &first.team_id, "client").await, (2, 20, 40));
    assert_eq!(
        store.team_usage(&user.id, &first.team_id).await.unwrap()["relayedBytes"],
        "40"
    );

    let mut invalid = event.clone();
    invalid.received_bytes = -1;
    assert!(matches!(
        store.record_turn_usage(&invalid).await,
        Err(Error::Invalid(_))
    ));
    invalid.received_bytes = 1;
    invalid.sent_bytes = -1;
    assert!(matches!(
        store.record_turn_usage(&invalid).await,
        Err(Error::Invalid(_))
    ));

    let mut unknown = event.clone();
    unknown.peer_id = uuid::Uuid::new_v4().to_string();
    assert!(!store.record_turn_usage(&unknown).await.unwrap());
    assert_eq!(totals(&store, &first.team_id, "client").await, (2, 20, 40));

    store.revoke_peer(&first.peer_id).await.unwrap();
    let mut revoked_usage = event.clone();
    revoked_usage.side = TurnUsageSide::Peer;
    revoked_usage.received_bytes = 40;
    revoked_usage.sent_bytes = 70;
    assert!(store.record_turn_usage(&revoked_usage).await.unwrap());
    assert_eq!(totals(&store, &first.team_id, "peer").await, (1, 40, 70));

    let mut expired_usage = event;
    expired_usage.peer_id = expired.peer_id;
    expired_usage.received_bytes = 7;
    expired_usage.sent_bytes = 8;
    assert!(store.record_turn_usage(&expired_usage).await.unwrap());
    assert_eq!(totals(&store, &expired.team_id, "client").await, (1, 7, 8));
    assert_eq!(totals(&store, &expired.team_id, "peer").await, (0, 0, 0));
    assert_eq!(totals(&store, &first.team_id, "client").await, (2, 20, 40));
    assert_eq!(
        store.team_usage(&user.id, &first.team_id).await.unwrap()["relayedBytes"],
        "110"
    );
    assert_eq!(
        store.team_usage(&user.id, &expired.team_id).await.unwrap()["relayedBytes"],
        "8"
    );
    assert!(matches!(
        store.team_usage("nonmember", &first.team_id).await,
        Err(Error::Forbidden)
    ));

    revoked_usage.sent_bytes = i64::MAX;
    for side in [TurnUsageSide::Client, TurnUsageSide::Peer] {
        revoked_usage.side = side;
        assert!(store.record_turn_usage(&revoked_usage).await.unwrap());
    }
    assert_eq!(
        store.team_usage(&user.id, &first.team_id).await.unwrap()["relayedBytes"],
        "18446744073709551724"
    );
    store.close().await.unwrap();
}
