//! Billing queue, pagination, and exact TURN aggregation against PostgreSQL.
use deskfleet_control_store::{ControlStore, TurnUsage, TurnUsageSide, now_ms, timestamp};
use deskfleet_protocol::control::{PeerActor, PeerAuthorization, PeerTarget};
use sea_orm::{
    ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement, TransactionTrait,
};
use serde_json::json;

fn sql(query: &str, values: Vec<sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, values)
}

async fn fixture() -> (ControlStore, DatabaseConnection, String, String) {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
    let db = Database::connect(&url).await.unwrap();
    let schema = format!("billing_perf_{}", uuid::Uuid::new_v4().simple());
    db.execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let store = ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
        .await
        .unwrap()
        .with_hosted_mode(true);
    let user = store
        .verified_user("owner@billing.test", "Owner")
        .await
        .unwrap();
    (store, db, schema, user.id)
}

async fn cleanup(store: ControlStore, db: DatabaseConnection, schema: String) {
    store.close().await.unwrap();
    db.execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    db.close().await.unwrap();
}

async fn peer(store: &ControlStore, owner: &str) -> (String, String) {
    let team = store.create_team(owner, "Usage").await.unwrap();
    let (machine, _) = store
        .enroll(
            owner,
            &team.id,
            "Machine",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    let session = store.new_session(owner).await.unwrap();
    let auth = store
        .authenticate(session["token"].as_str().unwrap())
        .await
        .unwrap();
    let grant = PeerAuthorization {
        peer_id: uuid::Uuid::new_v4().to_string(),
        server_id: "https://control.test".into(),
        team_id: team.id.clone(),
        actor: PeerActor {
            kind: "user".into(),
            user_id: owner.into(),
            device_id: auth.device_id,
            source_machine: None,
        },
        target_machine: PeerTarget {
            id: machine.id,
            origin_id: machine.origin_id,
            local_machine_id: "1".into(),
        },
        purpose: "agent".into(),
        actions: vec!["agent:read".into()],
        issued_at: timestamp(now_ms()),
        expires_at: timestamp(now_ms() + 60_000),
    };
    store
        .save_peer(&grant, &auth.id, now_ms() + 60_000)
        .await
        .unwrap();
    (team.id, grant.peer_id)
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn minute_totals_match_raw_usage_at_exact_boundaries_and_after_late_inserts() {
    let (store, db, schema, owner) = fixture().await;
    let (team, peer) = peer(&store, &owner).await;
    let mut event = TurnUsage {
        peer_id: peer,
        realm: "test".into(),
        allocation_id: "allocation".into(),
        side: TurnUsageSide::Client,
        received_bytes: 0,
        sent_bytes: 7,
        collected_at: 0,
    };
    // Include both edges, complete minutes, and late events for an old minute.
    for at in [
        0, 59_999, 60_000, 60_001, 119_999, 120_000, 120_001, 180_000, 60_000,
    ] {
        event.collected_at = at;
        assert!(store.record_turn_usage(&event).await.unwrap());
    }
    event.sent_bytes = i64::MAX;
    event.collected_at = 90_000;
    store.record_turn_usage(&event).await.unwrap();
    store.record_turn_usage(&event).await.unwrap();
    assert!(
        !store
            .record_turn_usage_owned(&event, Some("not-the-collector"))
            .await
            .unwrap()
    );
    let team_id = team.parse::<i64>().unwrap();
    let edges = [
        0_i64, 1, 59_999, 60_000, 60_001, 119_999, 120_000, 120_001, 180_001,
    ];
    for start in edges {
        for end in edges.into_iter().filter(|end| *end >= start) {
            let row = store.database().query_one_raw(sql(
                "SELECT cp_turn_sent_bytes($1,$2,$3)::text AS aggregate,(SELECT COALESCE(SUM(sent_bytes),0)::text FROM cp_turn_usage WHERE team_id=$1 AND collected_at >= $2 AND collected_at < $3) AS raw",
                vec![team_id.into(),start.into(),end.into()],
            )).await.unwrap().unwrap();
            assert_eq!(
                row.try_get::<String>("", "aggregate").unwrap(),
                row.try_get::<String>("", "raw").unwrap(),
                "range [{start},{end})"
            );
        }
    }
    // The trigger's aggregate update must roll back with its source insert.
    let tx = store.database().begin().await.unwrap();
    tx.execute_raw(sql(
        "INSERT INTO cp_turn_usage(peer_id,team_id,realm,allocation_id,side,received_bytes,sent_bytes,collected_at) VALUES($1,$2,'test','rollback','client',0,11,0)",
        vec![event.peer_id.into(),team_id.into()],
    )).await.unwrap();
    tx.rollback().await.unwrap();
    let row = store
        .database()
        .query_one_raw(sql(
            "SELECT cp_turn_sent_bytes($1,0,60000)::text AS bytes",
            vec![team_id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<String>("", "bytes").unwrap(), "14");
    cleanup(store, db, schema).await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn existing_turn_events_are_backfilled_before_future_inserts() {
    let (store, db, schema, owner) = fixture().await;
    let (team, peer) = peer(&store, &owner).await;
    let tx = store.database().begin().await.unwrap();
    tx.execute_unprepared(include_str!("../src/billing_performance_down.sql"))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut event = TurnUsage {
        peer_id: peer,
        realm: "test".into(),
        allocation_id: "historical".into(),
        side: TurnUsageSide::Peer,
        received_bytes: 0,
        sent_bytes: 17,
        collected_at: 60_001,
    };
    store.record_turn_usage(&event).await.unwrap();
    event.collected_at = 119_999;
    store.record_turn_usage(&event).await.unwrap();
    let tx = store.database().begin().await.unwrap();
    tx.execute_unprepared(include_str!("../src/billing_performance.sql"))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    store.record_turn_usage(&event).await.unwrap();
    let row = store
        .database()
        .query_one_raw(sql(
            "SELECT cp_turn_sent_bytes($1,60000,120000)::text AS bytes",
            vec![team.parse::<i64>().unwrap().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<String>("", "bytes").unwrap(), "51");
    cleanup(store, db, schema).await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn reconciliation_claims_are_due_exclusive_and_recover_expired_owners() {
    let (store, db, schema, owner) = fixture().await;
    let team = store.create_team(&owner, "Customer").await.unwrap();
    let lease = store
        .claim_billing_operation(&team.id)
        .await
        .unwrap()
        .unwrap();
    store
        .billing_customer(&team.id, &lease, "cus_fixture")
        .await
        .unwrap();
    assert!(
        store
            .claim_billing_reconciliation()
            .await
            .unwrap()
            .is_none()
    );
    store
        .release_billing_operation(&team.id, &lease)
        .await
        .unwrap();
    let (left, right) = tokio::join!(
        store.claim_billing_reconciliation(),
        store.claim_billing_reconciliation()
    );
    let claims: Vec<_> = [left.unwrap(), right.unwrap()]
        .into_iter()
        .flatten()
        .collect();
    assert_eq!(claims.len(), 1);
    let (claimed_team, first_token) = &claims[0];
    assert_eq!(claimed_team, &team.id);
    store
        .database()
        .execute_unprepared("UPDATE cp_billing_profiles SET lease_until=0,reconcile_after=0")
        .await
        .unwrap();
    let (_, next_token) = store.claim_billing_reconciliation().await.unwrap().unwrap();
    assert_ne!(first_token, &next_token);
    store
        .finish_billing_reconciliation(&team.id, first_token, true)
        .await
        .unwrap();
    assert!(
        store
            .claim_billing_operation(&team.id)
            .await
            .unwrap()
            .is_none(),
        "stale completion cannot release the replacement lease"
    );
    store
        .finish_billing_reconciliation(&team.id, &next_token, true)
        .await
        .unwrap();
    assert!(
        store
            .claim_billing_reconciliation()
            .await
            .unwrap()
            .is_none(),
        "successful work is scheduled for later"
    );
    let row = store
        .database()
        .query_one_raw(sql(
            "SELECT reconcile_after FROM cp_billing_profiles WHERE team_id=$1",
            vec![team.id.parse::<i64>().unwrap().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert!(row.try_get::<i64>("", "reconcile_after").unwrap() > now_ms());
    cleanup(store, db, schema).await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn admin_billing_pages_are_bounded_and_preserve_summary_values() {
    let (store, db, schema, owner) = fixture().await;
    assert!(store.admin_billing_teams(&owner, None, 100).await.is_err());
    store.grant_site_admin(&owner).await.unwrap();
    let mut ids = Vec::new();
    for i in 0..103 {
        ids.push(
            store
                .create_team(&owner, &format!("Team {i}"))
                .await
                .unwrap()
                .id,
        );
    }
    let first = store.admin_billing_teams(&owner, None, 1000).await.unwrap();
    assert_eq!(first.teams.len(), 100);
    assert_eq!(first.next_cursor.as_deref(), Some(ids[99].as_str()));
    for team in &first.teams {
        let id = team["id"].as_str().unwrap();
        assert_eq!(team["billing"], store.billing_summary(id).await.unwrap());
    }
    let second = store
        .admin_billing_teams(&owner, first.next_cursor.as_deref(), 100)
        .await
        .unwrap();
    assert_eq!(second.teams.len(), 3);
    assert!(second.next_cursor.is_none());
    assert_eq!(second.teams[0]["id"], ids[100]);
    assert!(
        store
            .admin_billing_teams(&owner, Some("invalid"), 100)
            .await
            .is_err()
    );
    cleanup(store, db, schema).await;
}
