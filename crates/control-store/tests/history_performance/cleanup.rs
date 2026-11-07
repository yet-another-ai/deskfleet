use super::{Fixture, command, event, snapshot};
use deskfleet_control_store::{Error, LegacyHistoryCursor};
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::{Value, json};

fn legacy_command(id: &str) -> Value {
    let mut receipt = command(id, "completed");
    receipt["method"] = json!("_deskfleet/session/read");
    receipt["params"] = json!({"throughSeq":"0"});
    receipt["result"] = snapshot("1", "5", "active");
    receipt["result"]["inputs"] = json!([{"content":"old conversation ".repeat(1000)}]);
    receipt
}

fn receipt_event(seq: &str, receipt: &Value) -> Value {
    json!({"sessionId":"1","seq":seq,"kind":"command","payload":receipt})
}

async fn replace_event(f: &Fixture, record: &Value, original: Option<String>) {
    f.store
        .database()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE cp_events SET record=$1, record_original=$2 WHERE registration_id=$3 AND session_id='1' AND seq=$4",
            vec![
                record.clone().into(),
                original.into(),
                f.machine.parse::<i64>().unwrap().into(),
                record["seq"].as_str().unwrap().parse::<i64>().unwrap().into(),
            ],
        ))
        .await
        .unwrap();
}

async fn replace_command(f: &Fixture, receipt: &Value) {
    f.store
        .database()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE cp_commands SET record=$1 WHERE registration_id=$2 AND command_id=$3",
            vec![
                receipt.clone().into(),
                f.machine.parse::<i64>().unwrap().into(),
                receipt["id"].as_str().unwrap().into(),
            ],
        ))
        .await
        .unwrap();
}

/// Raw reads include row revisions so no-op checks also catch unnecessary writes.
async fn stored(f: &Fixture) -> Value {
    let row = f
        .store
        .database()
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT (SELECT jsonb_agg(jsonb_build_object('seq',seq,'record',record,'original',record_original,'revision',xmin::text) ORDER BY seq) FROM cp_events) AS events, (SELECT jsonb_agg(jsonb_build_object('id',command_id,'record',record,'revision',xmin::text) ORDER BY command_id) FROM cp_commands) AS commands",
        ))
        .await
        .unwrap()
        .unwrap();
    json!({
        "events":row.try_get::<Option<Value>>("", "events").unwrap(),
        "commands":row.try_get::<Option<Value>>("", "commands").unwrap(),
    })
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn legacy_cleanup_preserves_replay_nul_and_unrelated_history() {
    let f = Fixture::new().await;
    let mut cursor = LegacyHistoryCursor::default();
    let receipt = legacy_command("10");
    let mut nul_event = receipt_event("1", &receipt);
    nul_event["annotation"] = json!("before\0after");
    let mut result_nul_event = receipt_event("2", &receipt);
    result_nul_event["payload"]["result"]["inputs"][0]["content"] = json!("old\0body");
    let mut unsupported = legacy_command("11");
    unsupported["method"] = json!("_deskfleet/input/submit");
    let mut malformed = legacy_command("12");
    malformed["result"]["session"]["id"] = json!(1);
    let original_events = vec![
        nul_event.clone(),
        result_nul_event.clone(),
        receipt_event("3", &unsupported),
        receipt_event("4", &malformed),
        event("5"),
    ];
    let current = snapshot("1", "5", "active");
    f.store
        .sync_history(
            &f.machine,
            "1",
            current.clone(),
            original_events.clone(),
            vec![receipt.clone(), unsupported.clone(), malformed.clone()],
        )
        .await
        .unwrap();
    // Restore the pre-compaction storage shape, including exact NUL originals.
    let mut projection = nul_event.clone();
    projection["annotation"] = json!("before\u{fffd}after");
    replace_event(&f, &projection, Some(nul_event.to_string())).await;
    let mut projection = result_nul_event.clone();
    projection["payload"]["result"]["inputs"][0]["content"] = json!("old\u{fffd}body");
    replace_event(&f, &projection, Some(result_nul_event.to_string())).await;
    replace_command(&f, &receipt).await;
    let before = stored(&f).await;

    let preview = f.store.legacy_history_counts().await.unwrap();
    assert_eq!((preview.events, preview.commands), (2, 1));
    assert_eq!(stored(&f).await, before, "preview must not write rows");
    for limit in [0, 1001, u32::MAX] {
        assert!(matches!(
            f.store
                .compact_legacy_history_batch(limit, &mut cursor)
                .await,
            Err(Error::Invalid(_))
        ));
    }
    assert_eq!(stored(&f).await, before);

    let first = f
        .store
        .compact_legacy_history_batch(1, &mut cursor)
        .await
        .unwrap();
    assert_eq!((first.events, first.commands), (1, 0));
    let pending = f.store.legacy_history_counts().await.unwrap();
    assert_eq!((pending.events, pending.commands), (1, 1));
    let second = f
        .store
        .compact_legacy_history_batch(1000, &mut cursor)
        .await
        .unwrap();
    assert_eq!((second.events, second.commands), (1, 1));

    let compact_result = json!({"kind":"session_snapshot","sessionId":"1"});
    let after = stored(&f).await;
    assert_eq!(
        after["events"][0]["record"]["payload"]["result"],
        compact_result
    );
    let exact: Value =
        serde_json::from_str(after["events"][0]["original"].as_str().unwrap()).unwrap();
    assert_eq!(exact["annotation"], "before\0after");
    assert_eq!(exact["payload"]["result"], compact_result);
    assert!(
        after["events"][1]["original"].is_null(),
        "discard the old original if compaction removes its only NUL"
    );
    assert_eq!(after["commands"][0]["record"]["result"], compact_result);
    for index in 2..5 {
        assert_eq!(after["events"][index], before["events"][index]);
    }
    for index in 1..3 {
        assert_eq!(after["commands"][index], before["commands"][index]);
    }
    let remaining = f.store.legacy_history_counts().await.unwrap();
    assert_eq!((remaining.events, remaining.commands), (0, 0));
    let repeat = f
        .store
        .compact_legacy_history_batch(100, &mut cursor)
        .await
        .unwrap();
    assert_eq!((repeat.events, repeat.commands), (0, 0));
    assert_eq!(
        stored(&f).await,
        after,
        "repeated cleanup must not rewrite rows"
    );

    // A daemon may still replay its original receipts; the compacted sequences
    // retain the same normalization and must remain valid idempotent retries.
    assert_eq!(
        f.store
            .sync_history(
                &f.machine,
                "1",
                current.clone(),
                original_events,
                vec![receipt, unsupported, malformed],
            )
            .await
            .unwrap(),
        "5"
    );
    assert_eq!(stored(&f).await, after);
    assert_eq!(
        f.store.session_snapshot(&f.machine, "1").await.unwrap()["snapshot"],
        current
    );
    assert_eq!(
        f.store.events(&f.machine, "1", 0, 10).await.unwrap()["events"][0],
        exact
    );
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn legacy_cleanup_shares_one_limit_between_event_and_command_rows() {
    let f = Fixture::new().await;
    let mut cursor = LegacyHistoryCursor::default();
    let first = legacy_command("10");
    let second = legacy_command("11");
    let legacy_event = receipt_event("1", &first);
    f.store
        .sync_history(
            &f.machine,
            "1",
            snapshot("1", "1", "active"),
            vec![legacy_event.clone()],
            vec![first.clone(), second.clone()],
        )
        .await
        .unwrap();
    replace_event(&f, &legacy_event, None).await;
    replace_command(&f, &first).await;
    replace_command(&f, &second).await;
    let first_batch = f
        .store
        .compact_legacy_history_batch(2, &mut cursor)
        .await
        .unwrap();
    assert_eq!((first_batch.events, first_batch.commands), (1, 1));
    let remaining = f.store.legacy_history_counts().await.unwrap();
    assert_eq!((remaining.events, remaining.commands), (0, 1));
    let second_batch = f
        .store
        .compact_legacy_history_batch(2, &mut cursor)
        .await
        .unwrap();
    assert_eq!((second_batch.events, second_batch.commands), (0, 1));
    f.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn legacy_cleanup_cursor_skips_processed_prefix_and_advances_only_on_commit() {
    let f = Fixture::new().await;
    let mut cursor = LegacyHistoryCursor::default();
    let first = legacy_command("10");
    let last = legacy_command("2");
    let ordinary_command = command("11", "completed");
    let first_event = receipt_event("1", &first);
    let last_event = receipt_event("3", &last);
    f.store
        .sync_history(
            &f.machine,
            "1",
            snapshot("1", "4", "active"),
            vec![
                first_event.clone(),
                event("2"),
                last_event.clone(),
                event("4"),
            ],
            vec![first.clone(), ordinary_command, last.clone()],
        )
        .await
        .unwrap();
    replace_event(&f, &first_event, None).await;
    replace_event(&f, &last_event, Some("invalid JSON".to_owned())).await;
    replace_command(&f, &first).await;
    replace_command(&f, &last).await;
    let before = stored(&f).await;
    let cursor_before = format!("{cursor:?}");
    // Decoding the second candidate fails after the first row was rewritten.
    // The database rollback and cursor must both leave that first row retryable.
    assert!(matches!(
        f.store.compact_legacy_history_batch(10, &mut cursor).await,
        Err(Error::Json(_))
    ));
    assert_eq!(stored(&f).await, before);
    assert_eq!(format!("{cursor:?}"), cursor_before);
    replace_event(&f, &last_event, None).await;

    let first_batch = f
        .store
        .compact_legacy_history_batch(1, &mut cursor)
        .await
        .unwrap();
    assert_eq!((first_batch.events, first_batch.commands), (1, 0));
    // Simulate an older writer reintroducing a candidate behind this pass.
    // The next batch must continue past the cursor, not rescan that prefix.
    replace_event(&f, &first_event, None).await;
    let second_batch = f
        .store
        .compact_legacy_history_batch(1, &mut cursor)
        .await
        .unwrap();
    assert_eq!((second_batch.events, second_batch.commands), (1, 0));
    let after_events = stored(&f).await;
    assert_eq!(after_events["events"][0]["record"], first_event);
    assert_eq!(after_events["events"][1], before["events"][1]);
    assert_eq!(
        after_events["events"][2]["record"]["payload"]["result"]["kind"],
        "session_snapshot"
    );
    assert_eq!(after_events["events"][3], before["events"][3]);

    for _ in 0..2 {
        let batch = f
            .store
            .compact_legacy_history_batch(1, &mut cursor)
            .await
            .unwrap();
        assert_eq!((batch.events, batch.commands), (0, 1));
    }
    let end = f
        .store
        .compact_legacy_history_batch(1, &mut cursor)
        .await
        .unwrap();
    assert_eq!((end.events, end.commands), (0, 0));
    let pending = f.store.legacy_history_counts().await.unwrap();
    assert_eq!((pending.events, pending.commands), (1, 0));
    assert_eq!(stored(&f).await["commands"][1], before["commands"][1]);

    let mut restarted = LegacyHistoryCursor::default();
    let final_batch = f
        .store
        .compact_legacy_history_batch(10, &mut restarted)
        .await
        .unwrap();
    assert_eq!((final_batch.events, final_batch.commands), (1, 0));
    let remaining = f.store.legacy_history_counts().await.unwrap();
    assert_eq!((remaining.events, remaining.commands), (0, 0));
    f.close().await;
}
