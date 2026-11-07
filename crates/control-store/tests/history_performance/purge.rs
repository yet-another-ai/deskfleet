use super::*;

async fn query(fixture: &Fixture, sql: &str) -> sea_orm::QueryResult {
    fixture
        .store
        .database()
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            [fixture.machine.parse::<i64>().unwrap().into()],
        ))
        .await
        .unwrap()
        .unwrap()
}

async fn set_deletion_times(fixture: &Fixture) {
    fixture
        .store
        .database()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE cp_sessions SET deleted_at=CASE WHEN session_id='1' THEN 10 ELSE 100 END WHERE registration_id=$1 AND deleted_at IS NOT NULL",
            [fixture.machine.parse::<i64>().unwrap().into()],
        ))
        .await
        .unwrap();
}

fn metered_snapshot() -> Value {
    let mut value = snapshot("1", "3", "archived");
    value["inputs"] =
        json!([{"id":"input-1","author":{"userId":"member-1"},"text":"private prompt"}]);
    value["turns"] = json!([{
        "id":"turn-1", "initialInputId":"input-1", "state":"completed",
        "endedAt":"2026-11-01T00:00:00Z", "model":{"modelId":"model-1"},
        "usage":{"inputTokens":12,"outputTokens":34}
    }]);
    value
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn purge_is_bounded_preserves_accounting_and_only_removes_old_deleted_content() {
    let fixture = Fixture::new().await;
    let (store, machine) = (&fixture.store, &fixture.machine);
    fixture.catalog(&["1", "2", "3", "4"]).await;
    let deleted = metered_snapshot();
    store
        .sync_history(
            machine,
            "1",
            deleted.clone(),
            vec![event("1"), event("2"), event("3")],
            vec![
                command("1", "completed"),
                command("2", "completed"),
                command("3", "completed"),
            ],
        )
        .await
        .unwrap();
    for (id, archive) in [("2", "active"), ("3", "archived"), ("4", "archived")] {
        store
            .sync_history(machine, id, snapshot(id, "0", archive), vec![], vec![])
            .await
            .unwrap();
    }
    // A second registration uses the same local Session ID and must be untouched.
    let owner = store
        .verified_user("other@fixture.test", "Other")
        .await
        .unwrap();
    let team = store.create_team(&owner.id, "Other Team").await.unwrap();
    let other = store
        .enroll(
            &owner.id,
            &team.id,
            "Other",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
            &deskfleet_control_store::secret(),
        )
        .await
        .unwrap()
        .0
        .id;
    store
        .sync_history(&other, "1", snapshot("1", "0", "active"), vec![], vec![])
        .await
        .unwrap();
    for sql in [
        "INSERT INTO cp_search_entries(registration_id,session_id,entry_key,entry_id,tail) SELECT $1,'1',i::text,i::text,'private tail' FROM generate_series(1,3) i",
        "INSERT INTO cp_search_documents(registration_id,kind,resource_id,entry_id,block_no,priority,content) SELECT $1,'chat','1',i::text,0,1,'private content' FROM generate_series(1,3) i",
        "INSERT INTO cp_search_documents(registration_id,kind,resource_id,entry_id,block_no,priority,content) VALUES($1,'schedule','1','schedule',0,1,'unrelated schedule')",
    ] {
        store
            .database()
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                sql,
                [machine.parse::<i64>().unwrap().into()],
            ))
            .await
            .unwrap();
    }
    let accounting: Value = query(&fixture,
        "SELECT jsonb_agg(to_jsonb(t)) AS value FROM cp_ai_turns t WHERE registration_id=$1 AND session_id='1'",
    ).await.try_get("", "value").unwrap();
    assert_eq!(accounting.as_array().unwrap().len(), 1);
    fixture.catalog(&["2", "3"]).await;
    set_deletion_times(&fixture).await;

    assert_eq!(
        store.deleted_history_counts(10).await.unwrap().sessions,
        0,
        "cutoff is exclusive"
    );
    let preview = store.deleted_history_counts(50).await.unwrap();
    assert_eq!(
        (preview.sessions, preview.events, preview.commands),
        (1, 3, 3)
    );
    assert_eq!(
        (
            preview.search_documents,
            preview.search_entries,
            preview.search_progress
        ),
        (4, 3, 1)
    );
    assert_eq!(
        query(
            &fixture,
            "SELECT snapshot FROM cp_sessions WHERE registration_id=$1 AND session_id='1'"
        )
        .await
        .try_get::<Value>("", "snapshot")
        .unwrap(),
        deleted,
        "preview leaves content intact",
    );

    let first = store.purge_deleted_history_batch(50, 2).await.unwrap();
    assert_eq!((first.sessions, first.events, first.commands), (0, 2, 2));
    assert_eq!(
        (
            first.search_documents,
            first.search_entries,
            first.search_progress
        ),
        (2, 2, 1)
    );
    assert_eq!(
        query(
            &fixture,
            "SELECT snapshot FROM cp_sessions WHERE registration_id=$1 AND session_id='1'"
        )
        .await
        .try_get::<Value>("", "snapshot")
        .unwrap(),
        deleted,
        "an interrupted cleanup retains its pending snapshot marker",
    );
    let second = store.purge_deleted_history_batch(50, 2).await.unwrap();
    assert_eq!((second.sessions, second.events, second.commands), (1, 1, 1));
    assert_eq!(
        (
            second.search_documents,
            second.search_entries,
            second.search_progress
        ),
        (2, 1, 0)
    );
    let tombstone = query(&fixture,
        "SELECT snapshot,deleted_at,snapshot_seq,event_seq FROM cp_sessions WHERE registration_id=$1 AND session_id='1'",
    ).await;
    assert_eq!(
        tombstone.try_get::<Value>("", "snapshot").unwrap(),
        json!({})
    );
    assert_eq!(tombstone.try_get::<i64>("", "deleted_at").unwrap(), 10);
    assert_eq!(tombstone.try_get::<i64>("", "snapshot_seq").unwrap(), 3);
    assert_eq!(tombstone.try_get::<i64>("", "event_seq").unwrap(), 3);
    assert_eq!(query(&fixture,
        "SELECT jsonb_agg(to_jsonb(t)) AS value FROM cp_ai_turns t WHERE registration_id=$1 AND session_id='1'",
    ).await.try_get::<Value>("", "value").unwrap(), accounting);
    assert_eq!(query(&fixture,
        "SELECT count(*) AS value FROM cp_search_documents WHERE registration_id=$1 AND kind='schedule' AND resource_id='1'",
    ).await.try_get::<i64>("", "value").unwrap(), 1);
    assert_eq!(
        store.session_snapshot(machine, "2").await.unwrap()["snapshot"],
        snapshot("2", "0", "active")
    );
    assert_eq!(
        store.session_snapshot(machine, "3").await.unwrap()["snapshot"],
        snapshot("3", "0", "archived")
    );
    assert_eq!(
        store.session_snapshot(&other, "1").await.unwrap()["snapshot"],
        snapshot("1", "0", "active")
    );
    assert_eq!(
        query(
            &fixture,
            "SELECT snapshot FROM cp_sessions WHERE registration_id=$1 AND session_id='4'",
        )
        .await
        .try_get::<Value>("", "snapshot")
        .unwrap(),
        snapshot("4", "0", "archived")
    );
    let empty =
        serde_json::to_value(deskfleet_control_store::PurgedHistoryCounts::default()).unwrap();
    assert_eq!(
        serde_json::to_value(store.deleted_history_counts(50).await.unwrap()).unwrap(),
        empty
    );
    assert_eq!(
        serde_json::to_value(store.purge_deleted_history_batch(50, 2).await.unwrap()).unwrap(),
        empty
    );

    fixture.catalog(&["1", "2", "3", "4"]).await;
    assert!(matches!(
        store
            .sync_history(machine, "1", deleted, vec![event("1")], vec![])
            .await,
        Err(Error::NotFound)
    ));
    assert!(matches!(
        store.session_snapshot(machine, "1").await,
        Err(Error::NotFound)
    ));
    assert_eq!(store.deleted_history_counts(50).await.unwrap().sessions, 0);
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn purge_rejects_invalid_batches_and_migration_preserves_deleted_usage() {
    let fixture = Fixture::new().await;
    let (store, machine) = (&fixture.store, &fixture.machine);
    for limit in [0, 1001] {
        assert!(matches!(
            store.purge_deleted_history_batch(50, limit).await,
            Err(Error::Invalid(_))
        ));
    }
    // Reproduce an installation at migration 30, then upgrade with existing usage.
    store
        .database()
        .execute_unprepared(include_str!("../../src/history_purge_down.sql"))
        .await
        .unwrap();
    store
        .database()
        .execute_unprepared("DELETE FROM cp_migrations WHERE version=31")
        .await
        .unwrap();
    fixture.catalog(&["1"]).await;
    store
        .sync_history(machine, "1", metered_snapshot(), vec![], vec![])
        .await
        .unwrap();
    fixture.catalog(&[]).await;
    set_deletion_times(&fixture).await;
    deskfleet_control_store::schema::migrate(store.database())
        .await
        .unwrap();
    deskfleet_control_store::schema::migrate(store.database())
        .await
        .unwrap();
    assert_eq!(
        store
            .purge_deleted_history_batch(50, 10)
            .await
            .unwrap()
            .sessions,
        1
    );
    assert_eq!(
        query(
            &fixture,
            "SELECT count(*) AS value FROM cp_ai_turns WHERE registration_id=$1 AND session_id='1'",
        )
        .await
        .try_get::<i64>("", "value")
        .unwrap(),
        1
    );
    // The migration does not disable normal active-Snapshot usage maintenance.
    fixture.catalog(&["2"]).await;
    let mut active = metered_snapshot();
    active["session"]["id"] = json!("2");
    active["session"]["archiveState"] = json!("active");
    store
        .sync_history(machine, "2", active, vec![], vec![])
        .await
        .unwrap();
    assert_eq!(
        query(
            &fixture,
            "SELECT count(*) AS value FROM cp_ai_turns WHERE registration_id=$1 AND session_id='2'",
        )
        .await
        .try_get::<i64>("", "value")
        .unwrap(),
        1
    );
    store
        .sync_history(machine, "2", snapshot("2", "3", "active"), vec![], vec![])
        .await
        .unwrap();
    assert_eq!(
        query(
            &fixture,
            "SELECT count(*) AS value FROM cp_ai_turns WHERE registration_id=$1 AND session_id='2'",
        )
        .await
        .try_get::<i64>("", "value")
        .unwrap(),
        0
    );
    fixture.close().await;
}
