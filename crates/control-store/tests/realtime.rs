//! Realtime ownership and delivery against actual PostgreSQL concurrency.
use deskfleet_control_store::{ControlStore, Error, RealtimeRoute};
use sea_orm::{
    ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement, TransactionTrait,
};
use serde_json::json;

struct Fixture {
    admin: DatabaseConnection,
    store: ControlStore,
    schema: String,
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
        let admin = Database::connect(&url).await.unwrap();
        let schema = format!("realtime_test_{}", uuid::Uuid::new_v4().simple());
        admin
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let scoped = format!("{url}{separator}options=-csearch_path%3D{schema}");
        let store = ControlStore::connect(&scoped).await.unwrap();
        Self {
            admin,
            store,
            schema,
        }
    }

    async fn finish(self) {
        self.store.close().await.unwrap();
        self.admin
            .execute_unprepared(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
        self.admin.close().await.unwrap();
    }

    async fn node(&self) -> String {
        let node = uuid::Uuid::new_v4().to_string();
        self.store.register_node(&node).await.unwrap();
        node
    }

    async fn machine(&self) -> String {
        let user = self
            .store
            .verified_user(
                &format!("realtime-{}@fixture.test", uuid::Uuid::new_v4()),
                "Operator",
            )
            .await
            .unwrap();
        let team = self.store.create_team(&user.id, "Routing").await.unwrap();
        self.store
            .enroll(
                &user.id,
                &team.id,
                "Worker",
                &uuid::Uuid::new_v4().to_string(),
                "1",
                json!({}),
            )
            .await
            .unwrap()
            .0
            .id
    }

    async fn expire(&self, node: &str) {
        self.store
            .database()
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE cp_realtime_nodes SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
                vec![node.into()],
            ))
            .await
            .unwrap();
    }
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn machine_claims_are_atomic_and_old_release_cannot_remove_the_new_socket() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let first = fixture.node().await;
    let second = fixture.node().await;
    let machine = fixture.machine().await;
    let first_route = RealtimeRoute {
        node_id: first.clone(),
        connection_id: "first-socket".into(),
    };
    let second_route = RealtimeRoute {
        node_id: second.clone(),
        connection_id: "second-socket".into(),
    };
    let (first_claim, second_claim) = tokio::join!(
        store.claim_machine_route(&machine, &first, &first_route.connection_id),
        store.claim_machine_route(&machine, &second, &second_route.connection_id),
    );
    let (old, current) = match (first_claim.unwrap(), second_claim.unwrap()) {
        (None, Some(previous)) => {
            assert_eq!(previous, first_route);
            (first_route, second_route)
        }
        (Some(previous), None) => {
            assert_eq!(previous, second_route);
            (second_route, first_route)
        }
        claims => panic!("expected one initial claim and one replacement, got {claims:?}"),
    };
    assert_eq!(
        store.machine_route(&machine).await.unwrap(),
        Some(current.clone())
    );
    assert!(
        store
            .route_is_current(&machine, &current.node_id, &current.connection_id)
            .await
            .unwrap()
    );
    assert!(
        !store
            .release_machine_route(&machine, &old.node_id, &old.connection_id)
            .await
            .unwrap()
    );
    store.release_node(&old.node_id).await.unwrap();
    assert_eq!(
        store.machine_route(&machine).await.unwrap(),
        Some(current.clone())
    );

    // Even a new socket on the same node is isolated from the old socket's exit.
    assert_eq!(
        store
            .claim_machine_route(&machine, &current.node_id, "replacement")
            .await
            .unwrap(),
        Some(current.clone())
    );
    assert!(
        !store
            .release_machine_route(&machine, &current.node_id, &current.connection_id)
            .await
            .unwrap()
    );
    assert!(
        store
            .release_machine_route(&machine, &current.node_id, "replacement")
            .await
            .unwrap()
    );
    assert_eq!(store.machine_route(&machine).await.unwrap(), None);
    fixture.finish().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn leases_fence_routes_and_expired_renewal_does_not_revive_old_ownership() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let node = fixture.node().await;
    let machine = fixture.machine().await;
    store
        .claim_machine_route(&machine, &node, "socket")
        .await
        .unwrap();
    assert!(store.heartbeat_node(&node).await.unwrap());
    assert!(
        store
            .publish_node(&node, &json!({"before": "expiry"}))
            .await
            .unwrap()
    );
    fixture.expire(&node).await;
    assert_eq!(store.machine_route(&machine).await.unwrap(), None);
    assert!(
        !store
            .route_is_current(&machine, &node, "socket")
            .await
            .unwrap()
    );
    assert!(
        !store
            .publish_node(&node, &json!({"after": "expiry"}))
            .await
            .unwrap()
    );
    assert!(matches!(
        store.claim_machine_route(&machine, &node, "stale").await,
        Err(Error::NotFound)
    ));
    assert!(
        store
            .take_node_messages(&node, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(!store.heartbeat_node(&node).await.unwrap());
    assert_eq!(store.machine_route(&machine).await.unwrap(), None);
    assert!(
        store
            .take_node_messages(&node, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(store.heartbeat_node(&node).await.unwrap());
    assert!(
        store
            .claim_machine_route(&machine, &node, "new")
            .await
            .unwrap()
            .is_none()
    );

    // Pruning is distinct from renewal: removed nodes must register again.
    fixture.expire(&node).await;
    store.prune_realtime().await.unwrap();
    assert!(matches!(
        store.heartbeat_node(&node).await,
        Err(Error::NotFound)
    ));
    store.register_node(&node).await.unwrap();
    assert_eq!(store.machine_route(&machine).await.unwrap(), None);

    // A heartbeat that began while live can acquire its row lock after expiry.
    store
        .claim_machine_route(&machine, &node, "waiting")
        .await
        .unwrap();
    store.database().execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE cp_realtime_nodes SET lease_until=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",
        vec![node.as_str().into()],
    )).await.unwrap();
    let lock = store.database().begin().await.unwrap();
    lock.query_one_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT id FROM cp_realtime_nodes WHERE id=$1 FOR UPDATE",
        vec![node.as_str().into()],
    ))
    .await
    .unwrap();
    let (renewed, ()) = tokio::join!(store.heartbeat_node(&node), async {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        lock.commit().await.unwrap();
    });
    assert!(!renewed.unwrap());
    assert_eq!(store.machine_route(&machine).await.unwrap(), None);
    fixture.finish().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn inbox_fans_out_to_live_nodes_and_delivers_late_committing_lower_ids() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let sender = fixture.node().await;
    let first = fixture.node().await;
    let second = fixture.node().await;
    let expired = fixture.node().await;
    fixture.expire(&expired).await;
    let broadcast = json!({"event": "membership_removed"});
    store.broadcast_nodes(&sender, &broadcast).await.unwrap();
    assert!(
        store
            .take_node_messages(&sender, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.take_node_messages(&first, 10).await.unwrap(),
        vec![broadcast.clone()]
    );
    assert_eq!(
        store.take_node_messages(&second, 10).await.unwrap(),
        vec![broadcast]
    );
    assert!(
        store
            .take_node_messages(&first, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .take_node_messages(&expired, 10)
            .await
            .unwrap()
            .is_empty()
    );

    // Reserve a lower identity without committing its row. A later publisher
    // commits and is consumed first; committing this transaction must still deliver.
    let pending = store.database().begin().await.unwrap();
    pending
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO cp_realtime_messages(node_id,payload) VALUES($1,$2)",
            vec![first.as_str().into(), json!({"sequence": "late"}).into()],
        ))
        .await
        .unwrap();
    assert!(
        store
            .publish_node(&first, &json!({"sequence": "early"}))
            .await
            .unwrap()
    );
    assert_eq!(
        store.take_node_messages(&first, 10).await.unwrap(),
        vec![json!({"sequence": "early"})]
    );
    pending.commit().await.unwrap();
    assert_eq!(
        store.take_node_messages(&first, 10).await.unwrap(),
        vec![json!({"sequence": "late"})]
    );

    for value in 0..3 {
        assert!(store.publish_node(&first, &json!(value)).await.unwrap());
    }
    assert_eq!(
        store.take_node_messages(&first, 2).await.unwrap(),
        vec![json!(0), json!(1)]
    );
    assert_eq!(
        store.take_node_messages(&first, 2).await.unwrap(),
        vec![json!(2)]
    );
    assert!(
        store
            .publish_node(&first, &json!({"expired": true}))
            .await
            .unwrap()
    );
    store
        .database()
        .execute_unprepared(
            "UPDATE cp_realtime_messages SET expires_at=clock_timestamp()-interval '1 second'",
        )
        .await
        .unwrap();
    assert!(
        store
            .take_node_messages(&first, 10)
            .await
            .unwrap()
            .is_empty()
    );
    store.prune_realtime().await.unwrap();
    let remaining = store
        .database()
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT COUNT(*) AS count FROM cp_realtime_messages",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "count")
        .unwrap();
    assert_eq!(remaining, 0);
    fixture.finish().await;
}
