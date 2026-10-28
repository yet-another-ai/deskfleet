//! Requires a real PostgreSQL TEST_DATABASE_URL; run with --ignored.
use chrono::{Days, Utc};
use deskfleet_control_store::{ControlStore, Error, now_ms, timestamp};
use serde_json::{Value, json};

async fn sync(
    store: &ControlStore,
    machine: &str,
    session: &str,
    turns: Vec<Value>,
    inputs: Vec<Value>,
) {
    store
        .sync_history(
            machine,
            session,
            json!({
                "session": {"id":session,"title":format!("Session {session}"),"lastEventSeq":"0"},
                "turns": turns, "inputs": inputs,
            }),
            vec![],
            vec![],
        )
        .await
        .unwrap();
}

fn turn(id: &str, ended_at: &str, input: &str, usage: Value, model: Value) -> Value {
    json!({
        "id":id,"initialInputId":input,"state":"completed","consumed":true,
        "endedAt":ended_at,"usage":usage,"model":model,
    })
}

fn usage(total: u64) -> Value {
    json!({"totalTokens":total,"inputTokens":total,"outputTokens":0})
}

fn group<'a>(result: &'a Value, kind: &str, id: &str) -> &'a Value {
    result[kind]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["id"] == id)
        .unwrap()
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_ai_usage_counts_snapshots_scopes_teams_and_preserves_coverage() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL to PostgreSQL");
    let store = ControlStore::connect(&url).await.unwrap();
    let suffix = uuid::Uuid::new_v4();
    let owner = store
        .verified_user(&format!("usage-owner-{suffix}@fixture.test"), "Owner")
        .await
        .unwrap();
    let member_email = format!("usage-member-{suffix}@fixture.test");
    let member = store
        .verified_user(&member_email, "Teammate")
        .await
        .unwrap();
    let outsider = store
        .verified_user(&format!("usage-outsider-{suffix}@fixture.test"), "Outsider")
        .await
        .unwrap();
    let team = store
        .create_team(&owner.id, "AI usage fixture")
        .await
        .unwrap();
    let other_team = store
        .create_team(&outsider.id, "Other AI fixture")
        .await
        .unwrap();
    let invite = store
        .invite(&owner.id, &team.id, &member_email, "member")
        .await
        .unwrap();
    store
        .accept_invite(&member.id, invite["token"].as_str().unwrap())
        .await
        .unwrap();
    let (machine, _) = store
        .enroll(
            &owner.id,
            &team.id,
            "Usage machine",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    let (other_machine, _) = store
        .enroll(
            &outsider.id,
            &other_team.id,
            "Other machine",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    let at = timestamp(now_ms() - 60_000);
    let model = json!({"id":"model-a","name":"Model A"});
    let model_b = json!({"id":"model-b","name":"Model B"});
    let inputs = vec![
        json!({"id":"1","author":{"userId":owner.id}}),
        json!({"id":"2","author":{"userId":member.id}}),
        json!({"id":"3","author":{"kind":"system"}}),
    ];
    let mut cancelled = turn("2", &at, "1", usage(0), model_b.clone());
    cancelled["state"] = json!("cancelled");
    let mut interrupted = turn("3", &at, "3", Value::Null, Value::Null);
    interrupted["state"] = json!("interrupted");
    let mut failed = turn("4", &at, "2", Value::Null, model.clone());
    failed["state"] = json!("failed");
    failed.as_object_mut().unwrap().remove("usage");
    let mut not_dispatched = turn("5", &at, "1", usage(999), model.clone());
    not_dispatched["consumed"] = json!(false);
    let mut running = turn("6", &at, "1", usage(999), model.clone());
    running["state"] = json!("running");
    let mut legacy = turn("7", &at, "missing", usage(5), Value::Null);
    legacy.as_object_mut().unwrap().remove("consumed");
    let turns = vec![
        turn(
            "1",
            &at,
            "1",
            json!({"totalTokens":100,"inputTokens":60,"outputTokens":30,
            "cachedReadTokens":20,"cachedWriteTokens":0,"thoughtTokens":10}),
            model.clone(),
        ),
        cancelled,
        interrupted,
        failed,
        not_dispatched,
        running,
        legacy,
    ];
    // An identical re-sync replaces the snapshot without adding consumption.
    sync(&store, &machine.id, "1", turns.clone(), inputs.clone()).await;
    sync(&store, &machine.id, "1", turns, inputs.clone()).await;
    sync(
        &store,
        &machine.id,
        "2",
        vec![turn("1", &at, "2", usage(7), model_b.clone())],
        inputs.clone(),
    )
    .await;
    // Equal Session/turn IDs on a different Team must never leak into this result.
    sync(
        &store,
        &other_machine.id,
        "1",
        vec![turn("1", &at, "1", usage(99_999), model.clone())],
        inputs.clone(),
    )
    .await;
    sync(
        &store,
        &machine.id,
        "3",
        vec![turn(
            "1",
            "2024-01-01T12:00:00Z",
            "1",
            usage(11),
            Value::Null,
        )],
        inputs.clone(),
    )
    .await;

    let summary = store
        .team_ai_usage(&owner.id, &team.id, "30d", "UTC")
        .await
        .unwrap();
    assert_eq!(
        summary["totals"],
        json!({"totalTokens":112,"inputTokens":72,"outputTokens":30,
        "cachedReadTokens":20,"cachedWriteTokens":0,"thoughtTokens":10,"turnCount":6,"reportedTurnCount":4})
    );
    assert_eq!(summary["buckets"].as_array().unwrap().len(), 30);
    assert_eq!(summary["heatmap"].as_array().unwrap().len(), 371);
    assert_eq!(
        summary["heatmap"]
            .as_array()
            .unwrap()
            .iter()
            .map(|day| day["totalTokens"].as_u64().unwrap())
            .sum::<u64>(),
        112
    );
    assert!(summary["lastSyncedAt"].is_string());
    assert_eq!(group(&summary, "models", "model-a")["totalTokens"], 100);
    assert_eq!(group(&summary, "models", "model-b")["reportedTurnCount"], 2);
    assert_eq!(group(&summary, "models", "unknown")["turnCount"], 2);
    assert_eq!(group(&summary, "members", &owner.id)["name"], "Owner");
    assert_eq!(group(&summary, "members", &member.id)["totalTokens"], 7);
    assert_eq!(group(&summary, "members", "unknown")["totalTokens"], 5);
    assert_eq!(
        summary["buckets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|day| day["totalTokens"].as_u64().unwrap())
            .sum::<u64>(),
        112
    );

    let week = store
        .team_ai_usage(&member.id, &team.id, "7d", "UTC")
        .await
        .unwrap();
    assert_eq!(week["totals"], summary["totals"]);
    assert_eq!(week["buckets"].as_array().unwrap().len(), 7);
    let expected_start = Utc::now()
        .date_naive()
        .checked_sub_days(Days::new(6))
        .unwrap();
    assert!(
        week["from"]
            .as_str()
            .unwrap()
            .starts_with(&expected_start.to_string())
    );
    let daily = store
        .team_ai_usage(&owner.id, &team.id, "24h", "Asia/Shanghai")
        .await
        .unwrap();
    assert_eq!(daily["totals"], summary["totals"]);
    assert_eq!(daily["buckets"].as_array().unwrap().len(), 25);
    let from = chrono::DateTime::parse_from_rfc3339(daily["from"].as_str().unwrap()).unwrap();
    let to = chrono::DateTime::parse_from_rfc3339(daily["to"].as_str().unwrap()).unwrap();
    assert_eq!((to - from).num_hours(), 24);

    let all = store
        .team_ai_usage(&owner.id, &team.id, "all", "UTC")
        .await
        .unwrap();
    assert_eq!(all["totals"]["totalTokens"], 123);
    assert_eq!(all["from"], "2024-01-01T00:00:00.000Z");
    let date = &at[..10];
    let sessions = store
        .team_ai_usage_sessions(&owner.id, &team.id, date, "UTC")
        .await
        .unwrap();
    assert_eq!(sessions["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(sessions["sessions"][0]["sessionId"], "1");
    assert_eq!(sessions["sessions"][0]["totalTokens"], 105);
    assert_eq!(sessions["sessions"][0]["turnCount"], 5);
    assert_eq!(sessions["sessions"][1]["cachedReadTokens"], Value::Null);
    assert_eq!(sessions["truncated"], false);
    assert!(sessions["sessions"][0].get("turns").is_none());
    assert!(matches!(
        store
            .team_ai_usage(&outsider.id, &team.id, "30d", "UTC")
            .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store
            .team_ai_usage_sessions(&outsider.id, &team.id, date, "UTC")
            .await,
        Err(Error::Forbidden)
    ));
    for (period, zone) in [("31d", "UTC"), ("30d", "Mars/Olympus")] {
        assert!(matches!(
            store.team_ai_usage(&owner.id, &team.id, period, zone).await,
            Err(Error::Invalid(_))
        ));
    }
    for invalid in ["2025-02-30", "2025-2-3", "0000-01-01", "tomorrow"] {
        assert!(matches!(
            store
                .team_ai_usage_sessions(&owner.id, &team.id, invalid, "UTC")
                .await,
            Err(Error::Invalid(_))
        ));
    }
    for (session, days, total) in [("4", 10, 13), ("5", 2, 17)] {
        sync(
            &store,
            &machine.id,
            session,
            vec![turn(
                "1",
                &timestamp(now_ms() - days * 24 * 60 * 60 * 1000),
                "missing",
                usage(total),
                Value::Null,
            )],
            vec![],
        )
        .await;
    }
    for (period, total) in [("24h", 112), ("7d", 129), ("30d", 142), ("all", 153)] {
        let range = store
            .team_ai_usage(&owner.id, &team.id, period, "UTC")
            .await
            .unwrap();
        assert_eq!(range["totals"]["totalTokens"], total);
        // The heatmap remains independent of the selected summary period.
        assert_eq!(
            range["heatmap"]
                .as_array()
                .unwrap()
                .iter()
                .map(|day| day["totalTokens"].as_u64().unwrap())
                .sum::<u64>(),
            142
        );
    }
    store.revoke_machine(&owner.id, &machine.id).await.unwrap();
    assert_eq!(
        store
            .team_ai_usage(&owner.id, &team.id, "30d", "UTC")
            .await
            .unwrap()["totals"]["totalTokens"],
        142
    );
    store.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn postgres_ai_usage_local_days_follow_dst_and_session_results_are_bounded() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL to PostgreSQL");
    let store = ControlStore::connect(&url).await.unwrap();
    let owner = store
        .verified_user(
            &format!("usage-dst-{}@fixture.test", uuid::Uuid::new_v4()),
            "DST Owner",
        )
        .await
        .unwrap();
    let team = store
        .create_team(&owner.id, "DST usage fixture")
        .await
        .unwrap();
    let (machine, _) = store
        .enroll(
            &owner.id,
            &team.id,
            "DST machine",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    let empty = store
        .team_ai_usage(&owner.id, &team.id, "30d", "America/New_York")
        .await
        .unwrap();
    assert_eq!(empty["totals"]["turnCount"], 0);
    assert_eq!(empty["totals"]["cachedReadTokens"], Value::Null);
    assert_eq!(empty["lastSyncedAt"], Value::Null);
    assert_eq!(empty["models"], json!([]));
    assert_eq!(empty["buckets"].as_array().unwrap().len(), 30);
    let times = [
        ("2025-11-02T03:59:59Z", 1_000), // Previous local date.
        ("2025-11-02T04:00:00Z", 2),
        ("2025-11-02T05:30:00Z", 3), // First 01:30.
        ("2025-11-02T06:30:00Z", 5), // Repeated 01:30.
        ("2025-11-03T04:59:59Z", 7),
        ("2025-11-03T05:00:00Z", 2_000), // Next local date.
    ];
    let turns = times
        .iter()
        .enumerate()
        .map(|(i, (at, total))| turn(&i.to_string(), at, "missing", usage(*total), Value::Null))
        .collect();
    sync(&store, &machine.id, "1", turns, vec![]).await;
    let day = store
        .team_ai_usage_sessions(&owner.id, &team.id, "2025-11-02", "America/New_York")
        .await
        .unwrap();
    assert_eq!(day["sessions"][0]["totalTokens"], 17);
    assert_eq!(day["sessions"][0]["turnCount"], 4);
    let all = store
        .team_ai_usage(&owner.id, &team.id, "all", "America/New_York")
        .await
        .unwrap();
    let bucket = all["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["start"] == "2025-11-02T04:00:00.000Z")
        .unwrap();
    assert_eq!(bucket["totalTokens"], 17);
    assert!(
        all["buckets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["start"] == "2025-11-03T05:00:00.000Z")
    );
    for id in 2_u64..=102 {
        sync(
            &store,
            &machine.id,
            &id.to_string(),
            vec![turn(
                "1",
                "2025-11-02T12:00:00Z",
                "missing",
                usage(id),
                Value::Null,
            )],
            vec![],
        )
        .await;
    }
    let limited = store
        .team_ai_usage_sessions(&owner.id, &team.id, "2025-11-02", "America/New_York")
        .await
        .unwrap();
    assert_eq!(limited["truncated"], true);
    assert_eq!(limited["sessions"].as_array().unwrap().len(), 100);
    assert_eq!(limited["sessions"][0]["sessionId"], "102");
    assert_eq!(limited["sessions"][0]["totalTokens"], 102);
    store.close().await.unwrap();
}
