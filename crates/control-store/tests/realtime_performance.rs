//! Batched presence and shared, bounded maintenance against PostgreSQL.
use deskfleet_control_store::{ControlStore, Error};
use sea_orm::{
    ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement, TransactionTrait,
};
use serde_json::json;
use std::collections::HashSet;
use std::time::Duration;

fn sql(query: &str, values: Vec<sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, values)
}

async fn wait_for_blocked_backend(store: &ControlStore, blocker: i32) -> i32 {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(row) = store
                .database()
                .query_one_raw(sql(
                    "SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",
                    vec![blocker.into()],
                ))
                .await
                .unwrap()
            {
                return row.try_get("", "pid").unwrap();
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("operation reached the expected database lock")
}

struct Fixture {
    store: ControlStore,
    database: DatabaseConnection,
    schema: String,
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
        let database = Database::connect(&url).await.unwrap();
        let schema = format!("realtime_perf_{}", uuid::Uuid::new_v4().simple());
        database
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let store =
            ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
                .await
                .unwrap();
        Self {
            store,
            database,
            schema,
        }
    }

    async fn machine(&self) -> String {
        let user = self
            .store
            .verified_user("owner@fixture.test", "Owner")
            .await
            .unwrap();
        let team = self.store.create_team(&user.id, "Team").await.unwrap();
        self.store
            .enroll(
                &user.id,
                &team.id,
                "Machine",
                &uuid::Uuid::new_v4().to_string(),
                "1",
                json!({}),
            )
            .await
            .unwrap()
            .0
            .id
    }

    async fn node(&self) -> String {
        let node = uuid::Uuid::new_v4().to_string();
        self.store.register_node(&node).await.unwrap();
        node
    }

    async fn close(self) {
        self.store.close().await.unwrap();
        self.database
            .execute_unprepared(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
        self.database.close().await.unwrap();
    }
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn batched_presence_preserves_lease_and_revocation_filters() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let live = fixture.node().await;
    let expired = fixture.node().await;
    let online = fixture.machine().await;
    let offline = fixture.machine().await;
    let revoked = fixture.machine().await;
    let unrouted = fixture.machine().await;
    store
        .claim_machine_route(&online, &live, "live")
        .await
        .unwrap();
    store
        .claim_machine_route(&offline, &expired, "expired")
        .await
        .unwrap();
    store
        .claim_machine_route(&revoked, &live, "revoked")
        .await
        .unwrap();
    store.database().execute_raw(sql("UPDATE cp_realtime_nodes SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",vec![expired.into()])).await.unwrap();
    store
        .database()
        .execute_raw(sql(
            "UPDATE cp_machines SET revoked=TRUE WHERE id=$1",
            vec![revoked.parse::<i64>().unwrap().into()],
        ))
        .await
        .unwrap();
    let machines = vec![
        online.clone(),
        offline,
        revoked,
        unrouted,
        online.clone(),
        "999999".into(),
    ];
    let result = store.online_machines(&machines).await.unwrap();
    assert_eq!(result, HashSet::from([online]));
    for machine in machines {
        assert_eq!(
            result.contains(&machine),
            store.machine_route(&machine).await.unwrap().is_some()
        );
    }
    assert!(store.online_machines(&[]).await.unwrap().is_empty());
    assert!(matches!(
        store.online_machines(&["invalid".into()]).await,
        Err(Error::Invalid(_))
    ));
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn replicas_share_one_expiry_claim_until_the_next_due_time() {
    let fixture = Fixture::new().await;
    let other = fixture.store.clone();
    let (a, b) = tokio::join!(
        fixture.store.claim_expiry_maintenance(),
        other.claim_expiry_maintenance()
    );
    assert_eq!(usize::from(a.unwrap()) + usize::from(b.unwrap()), 1);
    assert!(!fixture.store.claim_expiry_maintenance().await.unwrap());
    fixture.store.database().execute_unprepared("UPDATE cp_maintenance SET next_run_at=clock_timestamp()-interval '1 second' WHERE name='expiry'").await.unwrap();
    assert!(other.claim_expiry_maintenance().await.unwrap());
    assert!(!fixture.store.claim_expiry_maintenance().await.unwrap());
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn realtime_message_expiry_is_bounded_and_preserves_live_delivery() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let node = fixture.node().await;
    store.database().execute_raw(sql("INSERT INTO cp_realtime_messages(node_id,payload,expires_at) SELECT $1,jsonb_build_object('expired',g),clock_timestamp()-interval '1 second' FROM generate_series(1,1005) g",vec![node.clone().into()])).await.unwrap();
    for id in 1..=3 {
        assert!(
            store
                .publish_node(&node, &json!({"live":id}))
                .await
                .unwrap()
        );
    }
    let lock = store.database().begin().await.unwrap();
    lock.query_one_raw(sql("SELECT id FROM cp_realtime_messages WHERE expires_at<=clock_timestamp() ORDER BY id LIMIT 1 FOR UPDATE",vec![])).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), store.prune_realtime())
        .await
        .unwrap()
        .unwrap();
    let count: i64 = store
        .database()
        .query_one_raw(sql(
            "SELECT count(*) AS n FROM cp_realtime_messages",
            vec![],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "n")
        .unwrap();
    assert_eq!(
        count, 8,
        "one pass removes exactly1000 expired messages and skips a locked row"
    );
    lock.rollback().await.unwrap();
    store.prune_realtime().await.unwrap();
    assert_eq!(
        store.take_node_messages(&node, 10).await.unwrap(),
        vec![json!({"live":1}), json!({"live":2}), json!({"live":3})]
    );
    assert!(
        store
            .take_node_messages(&node, 10)
            .await
            .unwrap()
            .is_empty()
    );
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn expiry_pruning_locks_the_node_before_messages_during_renewal() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let node = fixture.node().await;
    store.database().execute_raw(sql(
        "INSERT INTO cp_realtime_messages(node_id,payload,expires_at) VALUES($1,'{}',clock_timestamp()-interval '1 second')",
        vec![node.clone().into()],
    )).await.unwrap();
    store.database().execute_raw(sql(
        "UPDATE cp_realtime_nodes SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        vec![node.clone().into()],
    )).await.unwrap();
    // Pause pruning after it takes the message row lock. With parent-first
    // deletion it already owns the node; a message-first implementation lets
    // renewal own that node and creates the opposite half of a deadlock.
    store.database().execute_unprepared(
        "CREATE FUNCTION gate_message_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended(TG_TABLE_SCHEMA,0)); RETURN OLD; END $$; CREATE TRIGGER gate_message_delete BEFORE DELETE ON cp_realtime_messages FOR EACH ROW EXECUTE FUNCTION gate_message_delete()",
    ).await.unwrap();
    let gate = store.database().begin().await.unwrap();
    gate.execute_unprepared("SELECT pg_advisory_xact_lock(hashtextextended(current_schema(),0))")
        .await
        .unwrap();
    let gate_pid: i32 = gate
        .query_one_raw(sql("SELECT pg_backend_pid() AS pid", vec![]))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "pid")
        .unwrap();
    let pruning_store = store.clone();
    let pruning = tokio::spawn(async move { pruning_store.prune_realtime().await });
    let pruning_pid = wait_for_blocked_backend(store, gate_pid).await;
    let renewing_store = store.clone();
    let renewing = tokio::spawn(async move { renewing_store.heartbeat_node(&node).await });
    wait_for_blocked_backend(store, pruning_pid).await;
    gate.rollback().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), pruning)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), renewing)
            .await
            .unwrap()
            .unwrap(),
        Err(Error::NotFound)
    ));
    let count: i64 = store
        .database()
        .query_one_raw(sql("SELECT count(*) AS n FROM cp_realtime_nodes", vec![]))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "n")
        .unwrap();
    assert_eq!(
        count, 0,
        "a pruned owner cannot be resurrected by its old heartbeat"
    );
    fixture.close().await;
}
