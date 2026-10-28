use super::*;

#[tokio::test]
async fn turn_usage_and_matching_events_survive_catalog_restart() {
    let file = File::new();
    let local = LocalCatalog::open(&file.0, "host").await.unwrap();
    let mut session = create(&local).await.session;
    let usages = [
        Some(json!({
            "totalTokens": 1250,
            "inputTokens": 1000,
            "outputTokens": 250,
            "thoughtTokens": 50,
            "cachedReadTokens": 600,
            "cachedWriteTokens": null,
            "_meta": {"provider": {"model": "fixture"}}
        })),
        Some(json!({"totalTokens": 0, "inputTokens": 0, "outputTokens": 0})),
        None,
    ];
    let mut turns = Vec::new();
    let mut events = Vec::new();
    for usage in usages {
        let submission = command(&local, Some(session.id)).await;
        let input = input(&local, &submission, session.last_event_seq.as_i64() + 1).await;
        let running: AgentTurn = parse(json!({
            "id": local.agent_allocate_id().await.unwrap().to_string(),
            "sessionId": session.id,
            "initialInputId": input.id,
            "dispatchCommandId": submission.id,
            "runGeneration": 1,
            "state": "running",
            "consumed": true,
            "startedAt": TIME
        }));
        assert_eq!(running.usage, None);
        let mut changes = transaction(&session);
        changes.command = Some(submission);
        changes.runs = vec![run(session.id, 1)];
        changes.inputs = vec![input];
        changes.turns = vec![running.clone()];
        changes.events = vec![event(session.id, EventKind::Turn, &running)];
        let started = local.agent_commit(changes).await.unwrap();
        session = started.session.unwrap();
        events.extend(started.events);

        let completed = AgentTurn {
            state: TurnState::Completed,
            ended_at: Some(TIME.into()),
            stop_reason: Some("end_turn".into()),
            usage: usage.clone(),
            ..running
        };
        let mut changes = transaction(&session);
        changes.turns = vec![completed.clone()];
        changes.events = vec![event(session.id, EventKind::Turn, &completed)];
        let finished = local.agent_commit(changes).await.unwrap();
        assert_eq!(
            finished.events[0].event.payload.get("usage"),
            usage.as_ref()
        );
        session = finished.session.unwrap();
        events.extend(finished.events);
        turns.push(completed);
    }
    local.close().await.unwrap();

    let local = LocalCatalog::open(&file.0, "host").await.unwrap();
    let snapshot = local.agent_snapshot(session.id).await.unwrap().unwrap();
    assert_eq!(snapshot.turns, turns);
    assert_eq!(snapshot.session.last_event_seq, session.last_event_seq);
    assert_eq!(
        local
            .agent_history(session.id, 0.into(), 100)
            .await
            .unwrap(),
        events
    );
    local.close().await.unwrap();
}
