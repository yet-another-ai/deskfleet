//! Exact historical billing and atomic bounded TURN compaction against PostgreSQL.
use deskfleet_control_store::{ControlStore, now_ms};
use sea_orm::{
    ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement, TransactionTrait,
};

fn sql(query: &str, values: Vec<sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, values)
}

struct Fixture {
    store: ControlStore,
    db: DatabaseConnection,
    schema: String,
    team: i64,
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
        let db = Database::connect(&url).await.unwrap();
        let schema = format!("turn_compaction_{}", uuid::Uuid::new_v4().simple());
        db.execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let store =
            ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
                .await
                .unwrap();
        let owner = store
            .verified_user("owner@compaction.test", "Owner")
            .await
            .unwrap();
        let team = store
            .create_team(&owner.id, "Compaction")
            .await
            .unwrap()
            .id
            .parse()
            .unwrap();
        Self {
            store,
            db,
            schema,
            team,
        }
    }

    async fn insert(&self, at: i64, bytes: i64) {
        // Billing records intentionally outlive their peer authorization.
        self.store.database().execute_raw(sql(
            "INSERT INTO cp_turn_usage(peer_id,team_id,realm,allocation_id,side,received_bytes,sent_bytes,collected_at) VALUES('expired-peer',$1,'test','allocation','client',0,$2,$3)",
            vec![self.team.into(), bytes.into(), at.into()],
        )).await.unwrap();
    }

    async fn raw_count(&self) -> i64 {
        self.store
            .database()
            .query_one_raw(sql(
                "SELECT COUNT(*) AS rows FROM cp_turn_usage WHERE team_id=$1",
                vec![self.team.into()],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "rows")
            .unwrap()
    }

    async fn assert_ranges(&self, events: &[(i64, i64)]) {
        let edges = [
            0_i64, 1, 59_999, 60_000, 60_001, 90_000, 90_001, 119_999, 120_000, 180_001,
        ];
        for start in edges {
            for end in edges.into_iter().filter(|end| *end >= start) {
                let expected: i128 = events
                    .iter()
                    .filter(|(at, _)| *at >= start && *at < end)
                    .map(|(_, bytes)| i128::from(*bytes))
                    .sum();
                let row = self
                    .store
                    .database()
                    .query_one_raw(sql(
                        "SELECT cp_turn_sent_bytes($1,$2,$3)::text AS bytes",
                        vec![self.team.into(), start.into(), end.into()],
                    ))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    row.try_get::<String>("", "bytes").unwrap(),
                    expected.to_string(),
                    "range [{start},{end})"
                );
            }
        }
    }

    async fn close(self) {
        self.store.close().await.unwrap();
        self.db
            .execute_unprepared(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
        self.db.close().await.unwrap();
    }
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn compaction_keeps_millisecond_boundaries_late_counters_and_recent_diagnostics() {
    let fixture = Fixture::new().await;
    let mut events = vec![
        (0, 7),
        (59_999, 11),
        (60_000, 13),
        (60_001, 17),
        (90_000, i64::MAX),
        (90_000, i64::MAX),
        (119_999, 19),
        (120_000, 23),
        (180_000, 0), // Legacy zero notifications disappear without an archive key.
    ];
    for &(at, bytes) in &events {
        fixture.insert(at, bytes).await;
    }
    fixture.insert(now_ms() - 6 * 86_400_000, 29).await;
    fixture.assert_ranges(&events).await;

    assert_eq!(fixture.store.compact_turn_usage(1).await.unwrap(), 1);
    assert_eq!(fixture.raw_count().await, 9);
    fixture.assert_ranges(&events).await;
    assert_eq!(fixture.store.compact_turn_usage(10_000).await.unwrap(), 8);
    assert_eq!(fixture.raw_count().await, 1);
    fixture.assert_ranges(&events).await;
    assert_eq!(fixture.store.compact_turn_usage(10_000).await.unwrap(), 0);

    let archive = fixture.store.database().query_one_raw(sql(
        "SELECT COUNT(*) AS minutes, SUM((SELECT COUNT(*) FROM jsonb_object_keys(sent_bytes_by_ms)))::bigint AS milliseconds FROM cp_turn_usage_archive WHERE team_id=$1",
        vec![fixture.team.into()],
    )).await.unwrap().unwrap();
    assert_eq!(archive.try_get::<i64>("", "minutes").unwrap(), 3);
    assert_eq!(archive.try_get::<i64>("", "milliseconds").unwrap(), 7);

    // A late delta shares a key with already compacted data and counts exactly once.
    fixture.insert(60_001, 31).await;
    events.push((60_001, 31));
    fixture.assert_ranges(&events).await;
    assert_eq!(fixture.store.compact_turn_usage(1).await.unwrap(), 1);
    fixture.assert_ranges(&events).await;
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn failed_and_rolled_back_compaction_keep_raw_billing_visible() {
    let fixture = Fixture::new().await;
    let events = [
        (60_001, 17),
        (90_000, i64::MAX),
        (90_000, i64::MAX),
        (90_000, 31),
    ];
    for &(at, bytes) in &events {
        fixture.insert(at, bytes).await;
    }
    let tx = fixture.store.database().begin().await.unwrap();
    tx.execute_unprepared("SELECT cp_compact_turn_usage(120000,10000)")
        .await
        .unwrap();
    // Another connection sees all counters while the move is still uncommitted.
    assert_eq!(fixture.raw_count().await, 4);
    fixture.assert_ranges(&events).await;
    tx.rollback().await.unwrap();
    assert_eq!(fixture.raw_count().await, 4);

    fixture.store.database().execute_unprepared(
        "ALTER TABLE cp_turn_usage_archive ADD CONSTRAINT reject_archive CHECK(false) NOT VALID",
    ).await.unwrap();
    assert!(fixture.store.compact_turn_usage(10_000).await.is_err());
    assert_eq!(fixture.raw_count().await, 4);
    fixture.assert_ranges(&events).await;
    fixture
        .store
        .database()
        .execute_unprepared("ALTER TABLE cp_turn_usage_archive DROP CONSTRAINT reject_archive")
        .await
        .unwrap();
    assert_eq!(fixture.store.compact_turn_usage(10_000).await.unwrap(), 4);
    fixture.assert_ranges(&events).await;

    // Down migration restores numeric counters even when one offset exceeds bigint.
    let tx = fixture.store.database().begin().await.unwrap();
    tx.execute_unprepared(include_str!("../src/turn_usage_compaction_down.sql"))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(fixture.raw_count().await, 4);
    fixture.assert_ranges(&events).await;
    let tx = fixture.store.database().begin().await.unwrap();
    tx.execute_unprepared(include_str!("../src/turn_usage_compaction.sql"))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(fixture.store.compact_turn_usage(10_000).await.unwrap(), 4);
    fixture.assert_ranges(&events).await;
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn concurrent_compactors_merge_one_minute_without_losing_or_double_counting() {
    let fixture = Fixture::new().await;
    fixture.store.database().execute_raw(sql(
        "INSERT INTO cp_turn_usage(peer_id,team_id,realm,allocation_id,side,received_bytes,sent_bytes,collected_at) SELECT 'expired-peer',$1,'test','allocation','peer',0,7,60001 FROM generate_series(1,1000)",
        vec![fixture.team.into()],
    )).await.unwrap();
    let (left, right) = tokio::join!(
        fixture.store.compact_turn_usage(500),
        fixture.store.compact_turn_usage(500),
    );
    assert_eq!(left.unwrap() + right.unwrap(), 1000);
    assert_eq!(fixture.raw_count().await, 0);
    fixture.assert_ranges(&[(60_001, 7000)]).await;
    fixture.close().await;
}
