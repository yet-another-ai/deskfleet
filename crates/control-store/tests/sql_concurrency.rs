//! Deterministic interleavings against PostgreSQL, using observed lock waits.
use std::time::Duration;

use deskfleet_control_store::{
    ControlStore, Error,
    billing::{BillingAnalyticsEvent, SubscriptionProjection},
    now_ms,
};
use sea_orm::{
    ConnectionTrait, Database, DatabaseConnection, DatabaseTransaction, DbBackend, Statement,
    TransactionTrait,
};
use serde_json::json;

fn sql(text: &str, values: Vec<sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, text, values)
}

struct Fixture {
    store: ControlStore,
    admin: DatabaseConnection,
    schema: String,
    owner: String,
    actor: String,
    team: String,
    machine: String,
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
        let admin = Database::connect(&url).await.unwrap();
        let schema = format!("sql_concurrency_{}", uuid::Uuid::new_v4().simple());
        admin
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let store =
            ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
                .await
                .unwrap();
        let owner = store
            .verified_user("owner@fixture.test", "Owner")
            .await
            .unwrap()
            .id;
        let actor = store
            .verified_user("actor@fixture.test", "Actor")
            .await
            .unwrap()
            .id;
        let team = store.create_team(&owner, "Team").await.unwrap().id;
        let machine = store
            .enroll(
                &owner,
                &team,
                "Machine",
                &uuid::Uuid::new_v4().to_string(),
                "1",
                json!({}),
            )
            .await
            .unwrap()
            .0
            .id;
        Self {
            store,
            admin,
            schema,
            owner,
            actor,
            team,
            machine,
        }
    }

    async fn block_team(&self) -> DatabaseTransaction {
        let tx = self.store.database().begin().await.unwrap();
        tx.execute_raw(sql(
            "SELECT id FROM cp_teams WHERE id=$1 FOR UPDATE",
            vec![self.team.parse::<i64>().unwrap().into()],
        ))
        .await
        .unwrap();
        tx
    }

    async fn wait_for_blocked(&self, tx: &DatabaseTransaction) {
        let pid: i32 = tx
            .query_one_raw(sql("SELECT pg_backend_pid() AS pid", vec![]))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "pid")
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let blocked: bool = self.admin.query_one_raw(sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked", vec![pid.into()])).await.unwrap().unwrap().try_get("", "blocked").unwrap();
                if blocked { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("operation must reach the held database lock");
    }

    async fn close(self) {
        self.store.close().await.unwrap();
        self.admin
            .execute_unprepared(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
        self.admin.close().await.unwrap();
    }
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn mutations_recheck_membership_after_concurrent_removal_or_demotion() {
    let fixture = Fixture::new().await;
    for (operation, demote) in [
        ("enroll", false),
        ("invite", false),
        ("revoke", false),
        ("rename_machine", false),
        ("rename_team", false),
        ("invite", true),
        ("revoke", true),
    ] {
        fixture
            .store
            .database()
            .execute_raw(sql(
                "INSERT INTO cp_members VALUES($1,$2,'admin') ON CONFLICT(team_id,user_id) DO UPDATE SET role='admin'",
                vec![
                    fixture.team.parse::<i64>().unwrap().into(),
                    fixture.actor.clone().into(),
                ],
            ))
            .await
            .unwrap();
        let tx = fixture.block_team().await;
        // Old Machine mutations wait here after their unprotected authorization.
        tx.execute_raw(sql(
            "SELECT id FROM cp_machines WHERE id=$1 FOR UPDATE",
            vec![fixture.machine.parse::<i64>().unwrap().into()],
        ))
        .await
        .unwrap();
        let store = fixture.store.clone();
        let actor = fixture.actor.clone();
        let team = fixture.team.clone();
        let machine = fixture.machine.clone();
        let task = tokio::spawn(async move {
            match operation {
                "enroll" => store
                    .enroll(
                        &actor,
                        &team,
                        "Late machine",
                        &uuid::Uuid::new_v4().to_string(),
                        "2",
                        json!({}),
                    )
                    .await
                    .map(|_| ()),
                "invite" => store
                    .invite(&actor, &team, "late@fixture.test", "admin")
                    .await
                    .map(|_| ()),
                "revoke" => store.revoke_machine(&actor, &machine).await,
                "rename_machine" => store
                    .rename_machine(&actor, &machine, "Late name")
                    .await
                    .map(|_| ()),
                "rename_team" => store
                    .rename_team(&actor, &team, "Late name")
                    .await
                    .map(|_| ()),
                _ => unreachable!(),
            }
        });
        fixture.wait_for_blocked(&tx).await;
        tx.execute_raw(sql(
            if demote {
                "UPDATE cp_members SET role='member' WHERE team_id=$1 AND user_id=$2"
            } else {
                "DELETE FROM cp_members WHERE team_id=$1 AND user_id=$2"
            },
            vec![
                fixture.team.parse::<i64>().unwrap().into(),
                fixture.actor.clone().into(),
            ],
        ))
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert!(
            matches!(task.await.unwrap(), Err(Error::Forbidden)),
            "{operation} must reject changed authorization (demotion={demote})"
        );
    }
    assert_eq!(
        fixture.store.machine(&fixture.machine).await.unwrap().name,
        "Machine"
    );
    assert_eq!(
        fixture.store.teams(&fixture.owner).await.unwrap()[0].name,
        "Team"
    );
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn subscription_waits_for_team_before_locking_profile() {
    let fixture = Fixture::new().await;
    let lease = fixture
        .store
        .claim_billing_operation(&fixture.team)
        .await
        .unwrap()
        .unwrap();
    let tx = fixture.block_team().await;
    let store = fixture.store.clone();
    let team = fixture.team.clone();
    let task = tokio::spawn(async move {
        store
            .apply_subscription(
                &team,
                &lease,
                &SubscriptionProjection {
                    subscription_id: "sub_fixture".into(),
                    status: "active".into(),
                    paid_plan: Some("pro".into()),
                    paid_through: Some(now_ms() + 86_400_000),
                    period_anchor: now_ms(),
                    cancel_at_period_end: false,
                },
                &[BillingAnalyticsEvent {
                    id: "invoice_fixture".into(),
                    name: "subscription_paid".into(),
                    user_id: None,
                    time: now_ms(),
                    value: None,
                    metadata: Default::default(),
                }],
            )
            .await
    });
    fixture.wait_for_blocked(&tx).await;
    // This is Enterprise's Team -> profile lock order. Reconciliation must not
    // hold the profile while waiting for the Team's analytics FK lock.
    tx.execute_unprepared("SET LOCAL lock_timeout='1s'")
        .await
        .unwrap();
    tx.execute_raw(sql(
        "SELECT team_id FROM cp_billing_profiles WHERE team_id=$1 FOR UPDATE",
        vec![fixture.team.parse::<i64>().unwrap().into()],
    ))
    .await
    .unwrap();
    tx.commit().await.unwrap();
    task.await.unwrap().unwrap();
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn admission_waits_for_team_before_machine_and_observes_revocation() {
    let fixture = Fixture::new().await;
    let tx = fixture.block_team().await;
    let store = fixture.store.clone();
    let machine = fixture.machine.clone();
    let task = tokio::spawn(async move {
        store
            .reserve_session(&machine, &uuid::Uuid::new_v4().to_string(), "create", None)
            .await
    });
    fixture.wait_for_blocked(&tx).await;
    tx.execute_unprepared("SET LOCAL lock_timeout='1s'")
        .await
        .unwrap();
    tx.execute_raw(sql(
        "UPDATE cp_machines SET revoked=TRUE WHERE id=$1",
        vec![fixture.machine.parse::<i64>().unwrap().into()],
    ))
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(matches!(task.await.unwrap(), Err(Error::NotFound)));
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn usage_projection_backfills_reconciles_and_rolls_back_with_snapshots() {
    let fixture = Fixture::new().await;
    // Start from the previous schema with real history to exercise the backfill.
    fixture
        .store
        .database()
        .execute_unprepared(include_str!("../src/ai_usage/projection_down.sql"))
        .await
        .unwrap();
    fixture
        .store
        .database()
        .execute_unprepared("DELETE FROM cp_migrations WHERE version=18")
        .await
        .unwrap();
    let mut snapshot = json!({
        "session":{"id":"1","title":"Task","lastEventSeq":"0"},
        "inputs":[{"id":"input","author":{"userId":fixture.actor}}, {"id":"input","author":{"userId":fixture.owner}}],
        "turns":[
            {"id":"current","state":"completed","initialInputId":"input","endedAt":"2026-10-31T01:00:00Z","usage":{"totalTokens":5}},
            {"id":"old","state":"failed","endedAt":"2020-01-01T00:00:00Z"},
            {"id":"skip","state":"completed","consumed":false,"endedAt":"2026-10-31T01:00:00Z"},
            {"id":"invalid","state":"completed","endedAt":"bad date"},
            {"id":"live","state":"running","endedAt":"2026-10-31T01:00:00Z"}
        ]
    });
    fixture
        .store
        .sync_history(&fixture.machine, "1", snapshot.clone(), vec![], vec![])
        .await
        .unwrap();
    deskfleet_control_store::schema::migrate(fixture.store.database())
        .await
        .unwrap();
    let row = fixture
        .store
        .database()
        .query_one_raw(sql("SELECT COUNT(*) AS count FROM cp_ai_turns", vec![]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "count").unwrap(), 2);
    let row = fixture
        .store
        .database()
        .query_one_raw(sql(
            "SELECT member_id,usage,xmin::text AS version FROM cp_ai_turns WHERE turn_id='current'",
            vec![],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        row.try_get::<String>("", "member_id").unwrap(),
        fixture.actor
    );
    assert_eq!(
        row.try_get::<serde_json::Value>("", "usage").unwrap(),
        json!({"totalTokens":5})
    );
    let version: String = row.try_get("", "version").unwrap();
    fixture
        .store
        .sync_history(&fixture.machine, "1", snapshot.clone(), vec![], vec![])
        .await
        .unwrap();
    // Even unrelated snapshot changes must not rewrite unchanged usage facts.
    snapshot["session"]["title"] = json!("Renamed");
    fixture
        .store
        .sync_history(&fixture.machine, "1", snapshot.clone(), vec![], vec![])
        .await
        .unwrap();
    let row = fixture
        .store
        .database()
        .query_one_raw(sql(
            "SELECT xmin::text AS version FROM cp_ai_turns WHERE turn_id='current'",
            vec![],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<String>("", "version").unwrap(), version);
    let stale = snapshot.clone();
    snapshot["session"]["lastEventSeq"] = json!("2");
    snapshot["turns"] = json!([{"id":"current","state":"completed","initialInputId":"input","endedAt":"2026-10-31T01:00:00Z","usage":{"totalTokens":7}}]);
    fixture
        .store
        .sync_history(&fixture.machine, "1", snapshot, vec![], vec![])
        .await
        .unwrap();
    fixture
        .store
        .sync_history(&fixture.machine, "1", stale, vec![], vec![])
        .await
        .unwrap();
    let row = fixture
        .store
        .database()
        .query_one_raw(sql(
            "SELECT COUNT(*) AS count,MAX((usage->>'totalTokens')::int) AS tokens FROM cp_ai_turns",
            vec![],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "count").unwrap(), 1);
    assert_eq!(row.try_get::<i32>("", "tokens").unwrap(), 7);
    let tx = fixture.store.database().begin().await.unwrap();
    tx.execute_unprepared("UPDATE cp_sessions SET snapshot=jsonb_set(snapshot,'{turns}','[]')")
        .await
        .unwrap();
    let row = tx
        .query_one_raw(sql("SELECT COUNT(*) AS count FROM cp_ai_turns", vec![]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "count").unwrap(), 0);
    tx.rollback().await.unwrap();
    let row = fixture
        .store
        .database()
        .query_one_raw(sql("SELECT COUNT(*) AS count FROM cp_ai_turns", vec![]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "count").unwrap(), 1);
    fixture
        .store
        .database()
        .execute_unprepared("DELETE FROM cp_sessions")
        .await
        .unwrap();
    let row = fixture
        .store
        .database()
        .query_one_raw(sql("SELECT COUNT(*) AS count FROM cp_ai_turns", vec![]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "count").unwrap(), 0);
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn usage_date_query_uses_time_index_without_expanding_history() {
    let fixture = Fixture::new().await;
    fixture
        .store
        .sync_history(
            &fixture.machine,
            "1",
            json!({"session":{"id":"1","lastEventSeq":"0"},"turns":[]}),
            vec![],
            vec![],
        )
        .await
        .unwrap();
    fixture.store.database().execute_unprepared(
        "UPDATE cp_sessions SET snapshot=jsonb_set(snapshot,'{turns}',(SELECT jsonb_agg(jsonb_build_object('id',g::text,'state','completed','endedAt','2020-01-01'::timestamptz+g*interval '1 minute')) FROM generate_series(1,20000) g))",
    ).await.unwrap();
    fixture
        .store
        .database()
        .execute_unprepared("ANALYZE cp_ai_turns; ANALYZE cp_machines; ANALYZE cp_sessions")
        .await
        .unwrap();
    let statement = format!(
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {}",
        include_str!("../src/ai_usage/turns.sql")
    );
    let row = fixture
        .store
        .database()
        .query_one_raw(sql(
            &statement,
            vec![
                fixture.team.parse::<i64>().unwrap().into(),
                "UTC".into(),
                Some(1_577_836_800_000_i64).into(),
                1_577_923_200_000_i64.into(),
            ],
        ))
        .await
        .unwrap()
        .unwrap();
    let plan: serde_json::Value = row.try_get("", "QUERY PLAN").unwrap();
    let text = plan.to_string();
    assert!(text.contains("cp_ai_turns_machine_time"), "{plan}");
    assert!(!text.contains("Function Scan"), "{plan}");
    println!("AI usage date plan: {plan}");
    fixture.close().await;
}
