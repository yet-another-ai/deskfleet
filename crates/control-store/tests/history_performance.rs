//! PostgreSQL behavior of batched history ingestion and bounded summary reads.
use deskfleet_control_store::{ControlStore, Error};
use sea_orm::{
    ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement, TransactionTrait,
};
use serde_json::{Value, json};

struct Fixture {
    store: ControlStore,
    database: DatabaseConnection,
    schema: String,
    machine: String,
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
        let database = Database::connect(&url).await.unwrap();
        let schema = format!("history_perf_{}", uuid::Uuid::new_v4().simple());
        database
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let store =
            ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
                .await
                .unwrap();
        let user = store
            .verified_user("owner@fixture.test", "Owner")
            .await
            .unwrap();
        let team = store.create_team(&user.id, "Team").await.unwrap();
        let machine = store
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
            .id;
        Self {
            store,
            database,
            schema,
            machine,
        }
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

fn snapshot(id: &str, seq: &str, archive: &str) -> Value {
    json!({"session":{"id":id,"workspaceId":"1","title":"Task","lifecycle":"ready","lastEventSeq":seq,"archiveState":archive},"runs":[],"inputs":[],"turns":[],"permissions":[],"elicitations":[]})
}

fn event(seq: &str) -> Value {
    json!({"sessionId":"1","seq":seq,"kind":"acp","payload":{"text":format!("event {seq}")}})
}

fn command(id: &str, status: &str) -> Value {
    json!({"id":id,"sessionId":"1","operationId":format!("op-{id}"),"isCanonical":true,"status":status})
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn history_pages_require_the_snapshot_and_commit_ordered_events_atomically() {
    let fixture = Fixture::new().await;
    let (store, machine) = (&fixture.store, &fixture.machine);
    assert!(
        store
            .sync_history_batch(
                machine,
                "1",
                None,
                Some("8".into()),
                vec![event("1")],
                vec![]
            )
            .await
            .is_err()
    );
    assert_eq!(
        store
            .sync_history(
                machine,
                "1",
                snapshot("1", "8", "active"),
                vec![event("1")],
                vec![]
            )
            .await
            .unwrap(),
        "1"
    );
    let stored = store.session_snapshot(machine, "1").await.unwrap();
    assert_eq!(stored["snapshot"]["session"]["lastEventSeq"], "8");
    assert_eq!(
        stored["lastEventSeq"], "1",
        "event ACK does not advance to the snapshot's future watermark"
    );
    assert_eq!(
        store.events(machine, "1", 0, 10).await.unwrap()["lastEventSeq"],
        "1"
    );
    assert!(matches!(
        store
            .sync_history_batch(
                machine,
                "1",
                None,
                Some("9".into()),
                vec![event("2")],
                vec![]
            )
            .await,
        Err(Error::Conflict(_))
    ));
    for events in [vec![event("3")], vec![event("3"), event("2")]] {
        assert!(matches!(
            store
                .sync_history_batch(machine, "1", None, Some("8".into()), events, vec![])
                .await,
            Err(Error::Conflict(_))
        ));
    }
    assert_eq!(
        store
            .sync_history_batch(
                machine,
                "1",
                None,
                Some("8".into()),
                vec![event("2"), event("2"), event("1")],
                vec![]
            )
            .await
            .unwrap(),
        "2"
    );
    let mut conflicting = event("1");
    conflicting["payload"] = json!({"text":"changed"});
    assert!(matches!(
        store
            .sync_history_batch(
                machine,
                "1",
                None,
                Some("8".into()),
                vec![event("3"), conflicting],
                vec![]
            )
            .await,
        Err(Error::Conflict(_))
    ));
    let mut duplicate = event("3");
    duplicate["payload"] = json!({"text":"different duplicate"});
    assert!(matches!(
        store
            .sync_history_batch(
                machine,
                "1",
                None,
                Some("8".into()),
                vec![event("3"), duplicate],
                vec![]
            )
            .await,
        Err(Error::Conflict(_))
    ));
    // Command validation occurs after event insertion, so this exercises actual
    // transaction rollback rather than only rejecting an invalid input upfront.
    assert!(
        store
            .sync_history_batch(
                machine,
                "1",
                None,
                Some("8".into()),
                vec![event("3")],
                vec![command("invalid", "accepted")]
            )
            .await
            .is_err()
    );
    let page = store.events(machine, "1", 0, 10).await.unwrap();
    assert_eq!(page["events"], json!([event("1"), event("2")]));
    assert_eq!(page["lastEventSeq"], "2");
    let remaining = (3..=8).map(|seq| event(&seq.to_string())).collect();
    assert_eq!(
        store
            .sync_history_batch(machine, "1", None, Some("8".into()), remaining, vec![])
            .await
            .unwrap(),
        "8"
    );
    assert_eq!(
        store.events(machine, "1", 6, 2).await.unwrap(),
        json!({"events":[event("7"),event("8")],"lastEventSeq":"8"})
    );
    assert_eq!(
        store.session_snapshot(machine, "1").await.unwrap()["snapshot"],
        snapshot("1", "8", "active")
    );
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn command_batches_keep_last_duplicate_and_ignore_stale_snapshots() {
    let fixture = Fixture::new().await;
    let (store, machine) = (&fixture.store, &fixture.machine);
    let current = snapshot("1", "2", "active");
    store
        .sync_history(
            machine,
            "1",
            current.clone(),
            vec![event("1"), event("2")],
            vec![
                command("10", "accepted"),
                command("2", "accepted"),
                command("10", "completed"),
            ],
        )
        .await
        .unwrap();
    assert_eq!(
        store.commands(machine, "1", 0, 1).await.unwrap(),
        json!({"commands":[command("2","accepted")],"nextCursor":"2"})
    );
    assert_eq!(
        store.commands(machine, "1", 2, 10).await.unwrap(),
        json!({"commands":[command("10","completed")]})
    );
    assert_eq!(
        store.command_by_operation(machine, "op-10").await.unwrap(),
        command("10", "completed")
    );
    let query = Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT xmin::text AS revision FROM cp_commands WHERE machine_id=$1 AND command_id='10'",
        vec![machine.parse::<i64>().unwrap().into()],
    );
    let before: String = store
        .database()
        .query_one_raw(query.clone())
        .await
        .unwrap()
        .unwrap()
        .try_get("", "revision")
        .unwrap();
    store
        .sync_history(
            machine,
            "1",
            current.clone(),
            vec![event("1"), event("2")],
            vec![command("10", "completed")],
        )
        .await
        .unwrap();
    let after: String = store
        .database()
        .query_one_raw(query)
        .await
        .unwrap()
        .unwrap()
        .try_get("", "revision")
        .unwrap();
    assert_eq!(
        before, after,
        "identical receipts do not create new row versions"
    );
    assert_eq!(
        store
            .sync_history(
                machine,
                "1",
                snapshot("1", "1", "archived"),
                vec![event("1")],
                vec![command("10", "accepted")]
            )
            .await
            .unwrap(),
        "2"
    );
    assert_eq!(
        store.session_snapshot(machine, "1").await.unwrap()["snapshot"],
        current
    );
    assert_eq!(
        store.command_by_operation(machine, "op-10").await.unwrap(),
        command("10", "completed")
    );
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn numeric_pages_return_only_notification_and_sidebar_summary_fields() {
    let fixture = Fixture::new().await;
    let (store, machine) = (&fixture.store, &fixture.machine);
    for (id, archive) in [
        ("1", "active"),
        ("2", "archived"),
        ("9", "active"),
        ("10", "archived"),
        ("11", "archiving"),
        ("100", "active"),
    ] {
        store
            .sync_history(machine, id, snapshot(id, "0", archive), vec![], vec![])
            .await
            .unwrap();
    }
    let page = store.sessions(machine, 2, 2, "all").await.unwrap();
    assert_eq!(
        page["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["session"]["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["9", "10"]
    );
    assert_eq!(page["nextCursor"], "10");
    let page = store.sessions(machine, 1, 1, "active").await.unwrap();
    assert_eq!(page["sessions"][0]["session"]["id"], "9");
    assert_eq!(page["nextCursor"], "9");
    let page = store.sessions(machine, 9, 1, "active").await.unwrap();
    assert_eq!(page["sessions"][0]["session"]["id"], "100");
    assert!(page.get("nextCursor").is_none());
    let mut detailed = snapshot("1", "3", "active");
    let large = "conversation and tool content ".repeat(4000);
    detailed["runs"] = json!([{"id":"run","record":large}]);
    detailed["inputs"] = json!([{"id":"input","text":large}]);
    detailed["turns"] = json!([
        {"id":"completed","state":"completed","endedAt":"2026-10-28T00:00:00Z","messages":large},
        {"id":"without-time","state":"completed","messages":large},
        {"id":"running","state":"running","messages":large}
    ]);
    detailed["permissions"] = json!([{"id":"permission","state":"pending","createdAt":"2026-10-28T00:00:01Z","params":large}]);
    detailed["elicitations"] = json!([{"id":"elicitation","state":"pending","createdAt":"2026-10-28T00:00:02Z","schema":large}]);
    store
        .sync_history(machine, "1", detailed.clone(), vec![event("1")], vec![])
        .await
        .unwrap();
    let summary = store.session_summary(machine, "1").await.unwrap()["sessions"][0].clone();
    assert_eq!(summary["session"], detailed["session"]);
    assert_eq!(
        summary["turns"],
        json!([{"id":"completed","state":"completed","endedAt":"2026-10-28T00:00:00Z"},{"id":"without-time","state":"completed"}])
    );
    assert_eq!(
        summary["permissions"],
        json!([{"id":"permission","state":"pending","createdAt":"2026-10-28T00:00:01Z"}])
    );
    assert_eq!(
        summary["elicitations"],
        json!([{"id":"elicitation","state":"pending","createdAt":"2026-10-28T00:00:02Z"}])
    );
    assert!(summary.get("inputs").is_none() && summary.get("runs").is_none());
    assert!(summary.to_string().len() < 1000);
    assert_eq!(
        store.sessions(machine, 0, 1, "all").await.unwrap()["sessions"][0],
        summary
    );
    assert_eq!(
        store.session_snapshot(machine, "1").await.unwrap()["snapshot"],
        detailed
    );
    assert_eq!(
        store.events(machine, "1", 0, 10).await.unwrap()["lastEventSeq"],
        "1"
    );

    // Generic prepared plans must retain indexable archive and numeric keys.
    let tx = store.database().begin().await.unwrap();
    tx.execute_unprepared(
        "SET LOCAL plan_cache_mode=force_generic_plan; SET LOCAL enable_seqscan=off",
    )
    .await
    .unwrap();
    tx.execute_unprepared("PREPARE history_all(bigint,bigint,bigint) AS SELECT summary FROM cp_sessions WHERE machine_id=$1 AND session_id::bigint>$2 ORDER BY session_id::bigint LIMIT $3; PREPARE history_archive(bigint,text,bigint,bigint) AS SELECT summary FROM cp_sessions WHERE machine_id=$1 AND summary#>>'{session,archiveState}'=$2 AND session_id::bigint>$3 ORDER BY session_id::bigint LIMIT $4; PREPARE history_commands(bigint,text,bigint,bigint) AS SELECT record FROM cp_commands WHERE machine_id=$1 AND record->>'sessionId'=$2 AND command_id::bigint>$3 ORDER BY command_id::bigint LIMIT $4").await.unwrap();
    for (execute, index) in [
        (format!("history_all({machine},2,3)"), "cp_sessions_numeric"),
        (
            format!("history_archive({machine},'active',2,3)"),
            "cp_sessions_archive_numeric",
        ),
        (
            format!("history_commands({machine},'1',2,3)"),
            "cp_commands_session_numeric",
        ),
    ] {
        let plan: Value = tx
            .query_one_raw(Statement::from_string(
                DbBackend::Postgres,
                format!("EXPLAIN (FORMAT JSON) EXECUTE {execute}"),
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "QUERY PLAN")
            .unwrap();
        let plan = plan.to_string();
        assert!(plan.contains(index), "{plan}");
        assert!(!plan.contains("\"Node Type\":\"Sort\""), "{plan}");
    }
    tx.execute_unprepared(
        "DEALLOCATE history_all; DEALLOCATE history_archive; DEALLOCATE history_commands",
    )
    .await
    .unwrap();
    tx.rollback().await.unwrap();
    fixture.close().await;
}
