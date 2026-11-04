use super::{Fixture, command, event, snapshot};
use deskfleet_control_store::{Error, schema};
use sea_orm::{ConnectionTrait, DbBackend, Statement, TransactionTrait};
use serde_json::{Value, json};

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn snapshot_receipts_are_compact_and_old_events_replay_without_content_growth() {
    let f = Fixture::new().await;
    let mut current = snapshot("1", "1", "active");
    current["inputs"] =
        json!([{"content":[{"type":"image","mimeType":"image/png","data":"A".repeat(100_000)}]}]);
    let mut receipt = command("10", "completed");
    receipt["method"] = json!("_deskfleet/session/read");
    receipt["params"] = json!({"throughSeq":"0"});
    receipt["result"] = current.clone();
    let command_event = json!({"sessionId":"1","seq":"1","kind":"command","payload":receipt});
    f.store
        .sync_history(
            &f.machine,
            "1",
            current.clone(),
            vec![command_event.clone()],
            vec![receipt.clone()],
        )
        .await
        .unwrap();
    let expected = json!({"kind":"session_snapshot","sessionId":"1"});
    assert_eq!(
        f.store
            .command_by_operation(&f.machine, "op-10")
            .await
            .unwrap()["result"],
        expected
    );
    assert_eq!(
        f.store.events(&f.machine, "1", 0, 10).await.unwrap()["events"][0]["payload"]["result"],
        expected
    );
    let bytes: i32 = f
        .store
        .database()
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT octet_length(record::text) AS bytes FROM cp_commands",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "bytes")
        .unwrap();
    assert!(
        bytes < 1000,
        "command must not persist the 100KB conversation"
    );

    // Simulate an already persisted event, before compact receipts were introduced.
    f.store
        .database()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE cp_events SET record=$1",
            vec![command_event.clone().into()],
        ))
        .await
        .unwrap();
    let mut compact_event = command_event.clone();
    compact_event["payload"]["result"] = expected.clone();
    f.store
        .sync_history(
            &f.machine,
            "1",
            current.clone(),
            vec![compact_event],
            vec![],
        )
        .await
        .unwrap();
    f.store
        .sync_history(
            &f.machine,
            "1",
            current.clone(),
            vec![command_event.clone()],
            vec![receipt],
        )
        .await
        .unwrap();
    let mut changed = command_event;
    changed["payload"]["params"]["throughSeq"] = json!("1");
    assert!(matches!(
        f.store
            .sync_history(&f.machine, "1", current, vec![changed], vec![])
            .await,
        Err(Error::Conflict(_))
    ));
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn media_references_stay_references_and_explicit_inline_content_is_preserved() {
    let f = Fixture::new().await;
    let content = json!([
        {"type":"resource_link","uri":"file:///not-on-server/movie.mp4","name":"movie.mp4","mimeType":"video/mp4","size":999999999},
        {"type":"resource_link","uri":"https://127.0.0.1:1/photo.png","name":"photo.png","mimeType":"image/png"},
        {"type":"image","mimeType":"image/png","data":"inline-image-base64"},
        {"type":"audio","mimeType":"audio/wav","data":"inline-audio-base64"},
        {"type":"resource","resource":{"uri":"inline://video","mimeType":"video/mp4","blob":"inline-video-base64"}}
    ]);
    let mut current = snapshot("1", "1", "active");
    current["inputs"] = json!([{"id":"input-1","content":content}]);
    let update = json!({"sessionId":"1","seq":"1","kind":"input","payload":{"id":"input-1","content":content}});
    f.store
        .sync_history(
            &f.machine,
            "1",
            current.clone(),
            vec![update.clone()],
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        f.store.session_snapshot(&f.machine, "1").await.unwrap()["snapshot"],
        current
    );
    assert_eq!(
        f.store.events(&f.machine, "1", 0, 10).await.unwrap()["events"],
        json!([update])
    );
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn stale_catalog_and_history_cannot_undo_soft_deletion() {
    let f = Fixture::new().await;
    f.catalog(&["1", "2"]).await;
    for id in ["1", "2"] {
        f.store
            .sync_history(
                &f.machine,
                id,
                snapshot(id, "0", "archived"),
                vec![],
                vec![],
            )
            .await
            .unwrap();
    }
    // Archive itself is retained and readable. Only removal from inventory deletes.
    assert!(f.store.session_snapshot(&f.machine, "1").await.is_ok());
    f.catalog(&["2"]).await;
    let deleted_at: i64 = f
        .store
        .database()
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT deleted_at FROM cp_sessions WHERE session_id='1'",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "deleted_at")
        .unwrap();
    f.catalog(&["1", "2"]).await;
    assert!(matches!(
        f.store
            .sync_history(
                &f.machine,
                "1",
                snapshot("1", "1", "active"),
                vec![event("1")],
                vec![]
            )
            .await,
        Err(Error::NotFound)
    ));
    assert!(matches!(
        f.store.session_snapshot(&f.machine, "1").await,
        Err(Error::NotFound)
    ));
    assert_eq!(
        f.store.sessions(&f.machine, 0, 10, "all").await.unwrap()["sessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(f.store.session_snapshot(&f.machine, "2").await.is_ok());
    f.catalog(&["2"]).await;
    let same: i64 = f
        .store
        .database()
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT deleted_at FROM cp_sessions WHERE session_id='1'",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "deleted_at")
        .unwrap();
    assert_eq!(same, deleted_at);
    assert!(matches!(
        f.store
            .sync_history(
                &f.machine,
                "3",
                snapshot("3", "0", "active"),
                vec![],
                vec![]
            )
            .await,
        Err(Error::NotFound)
    ));
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn soft_delete_migration_waits_for_a_versioned_inventory() {
    let f = Fixture::new().await;
    for id in ["1", "2"] {
        f.store
            .sync_history(
                &f.machine,
                id,
                snapshot(id, "0", "archived"),
                vec![],
                vec![],
            )
            .await
            .unwrap();
    }
    // Reproduce the old schema with an inventory that no longer includes Session 1.
    let tx = f.store.database().begin().await.unwrap();
    tx.execute_unprepared(include_str!("../../src/history_retention_down.sql"))
        .await
        .unwrap();
    tx.execute_unprepared("DELETE FROM cp_migrations WHERE version=28")
        .await
        .unwrap();
    tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO cp_catalogs(registration_id,snapshot,providers,observed_at) VALUES($1,$2,'{}',0)",
        vec![f.machine.parse::<i64>().unwrap().into(),json!({"sessionIds":["2"]}).into()])).await.unwrap();
    tx.commit().await.unwrap();
    schema::migrate(f.store.database()).await.unwrap();
    let rows: Value = f
        .store
        .database()
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT jsonb_object_agg(session_id,deleted_at IS NOT NULL) AS flags FROM cp_sessions",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "flags")
        .unwrap();
    assert_eq!(rows, json!({"1":false,"2":false}));
    f.catalog(&["2"]).await;
    assert!(matches!(
        f.store.session_snapshot(&f.machine, "1").await,
        Err(Error::NotFound)
    ));
    assert!(f.store.session_snapshot(&f.machine, "2").await.is_ok());
    schema::migrate(f.store.database()).await.unwrap();
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn older_catalog_replays_cannot_delete_later_sessions() {
    let f = Fixture::new().await;
    f.catalog(&["1"]).await;
    f.catalog(&["1", "2"]).await;
    f.store
        .sync_history(
            &f.machine,
            "2",
            snapshot("2", "0", "active"),
            vec![],
            vec![],
        )
        .await
        .unwrap();
    f.store
        .save_catalog(&f.machine, "1", json!({"sessionIds":["1"]}), json!({}))
        .await
        .unwrap();
    assert!(f.store.session_snapshot(&f.machine, "2").await.is_ok());
    assert_eq!(
        f.store.catalog(&f.machine).await.unwrap()["snapshot"]["sessionIds"],
        json!(["1", "2"])
    );
    f.catalog(&["1", "2"]).await;
    assert!(f.store.session_snapshot(&f.machine, "2").await.is_ok());
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn history_waiting_on_catalog_removal_cannot_recreate_the_session() {
    use std::time::Duration;

    async fn waiting_on(store: &deskfleet_control_store::ControlStore, blocker: i32) -> i32 {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(row) = store
                    .database()
                    .query_one_raw(Statement::from_sql_and_values(
                        DbBackend::Postgres,
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

    let f = Fixture::new().await;
    f.catalog(&["1"]).await;
    f.store
        .sync_history(
            &f.machine,
            "1",
            snapshot("1", "0", "active"),
            vec![],
            vec![],
        )
        .await
        .unwrap();

    // Hold the Session row so catalog removal pauses after it owns the
    // registration lock, but before its deletion marker becomes visible.
    let blocker = f.store.database().begin().await.unwrap();
    let blocker_pid: i32 = blocker
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT pg_backend_pid() AS pid FROM cp_sessions WHERE session_id='1' FOR UPDATE",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "pid")
        .unwrap();
    let removal = {
        let store = f.store.clone();
        let machine = f.machine.clone();
        tokio::spawn(async move {
            store
                .save_catalog(&machine, "2", json!({"sessionIds":[]}), json!({}))
                .await
        })
    };
    let removal_pid = waiting_on(&f.store, blocker_pid).await;
    let upload = {
        let store = f.store.clone();
        let machine = f.machine.clone();
        tokio::spawn(async move {
            store
                .sync_history(
                    &machine,
                    "1",
                    snapshot("1", "1", "active"),
                    vec![event("1")],
                    vec![],
                )
                .await
        })
    };
    waiting_on(&f.store, removal_pid).await;
    blocker.commit().await.unwrap();
    removal.await.unwrap().unwrap();
    assert!(matches!(upload.await.unwrap(), Err(Error::NotFound)));
    assert!(matches!(
        f.store.session_snapshot(&f.machine, "1").await,
        Err(Error::NotFound)
    ));
    let count: i64 = f
        .store
        .database()
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT count(*) AS count FROM cp_events",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "count")
        .unwrap();
    assert_eq!(count, 0, "the rejected upload must not append an event");
    f.close().await;
}
