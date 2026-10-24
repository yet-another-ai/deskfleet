use super::*;

async fn question(local: &LocalCatalog, session: AgentSessionId) -> AgentElicitation {
    parse(json!({
        "id": local.agent_allocate_id().await.unwrap().to_string(),
        "sessionId": session,
        "runGeneration": 1,
        "request": {
            "sessionId": "provider-session",
            "toolCallId": "question-call",
            "mode": "form",
            "message": "Choose the implementation scope",
            "requestedSchema": {
                "type": "object",
                "properties": {"scope": {"type": "string", "enum": ["small", "full"]}},
                "required": ["scope"]
            }
        },
        "state": "pending",
        "createdAt": TIME
    }))
}

#[tokio::test]
async fn pending_questions_survive_restart_and_recovery_cancellation_is_durable() {
    let file = File::new();
    let local = LocalCatalog::open(&file.0, "host").await.unwrap();
    let session = create(&local).await.session;
    let pending = question(&local, session.id).await;
    let active_run = run(session.id, 1);
    let mut changes = transaction(&session);
    changes.runs = vec![active_run.clone()];
    changes.elicitations = vec![pending.clone()];
    changes.events = vec![event(session.id, EventKind::Elicitation, &pending)];
    local.agent_commit(changes).await.unwrap();
    local.close().await.unwrap();

    let local = LocalCatalog::open(&file.0, "host").await.unwrap();
    let snapshot = local.agent_snapshot(session.id).await.unwrap().unwrap();
    assert_eq!(snapshot.elicitations, std::slice::from_ref(&pending));
    let cancelled = AgentElicitation {
        state: ElicitationState::Cancelled,
        response: Some(json!({"action": "cancel"})),
        resolved_at: Some(TIME.into()),
        ..pending
    };
    let interrupted = AgentRun {
        state: RunState::Interrupted,
        ended_at: Some(TIME.into()),
        ..active_run
    };
    let mut changes = transaction(&snapshot.session);
    changes.runs = vec![interrupted.clone()];
    changes.elicitations = vec![cancelled.clone()];
    changes.events = vec![
        event(session.id, EventKind::Run, &interrupted),
        event(session.id, EventKind::Elicitation, &cancelled),
    ];
    let recovery = local.agent_commit(changes).await.unwrap();
    local.close().await.unwrap();

    let local = LocalCatalog::open(&file.0, "host").await.unwrap();
    let snapshot = local.agent_snapshot(session.id).await.unwrap().unwrap();
    assert_eq!(snapshot.elicitations, std::slice::from_ref(&cancelled));
    assert_eq!(snapshot.runs, [interrupted]);
    assert_eq!(snapshot.session.last_event_seq.as_i64(), 3);
    assert_eq!(
        local.agent_history(session.id, 1.into(), 10).await.unwrap(),
        recovery.events
    );
    let mut reopened = cancelled;
    reopened.state = ElicitationState::Pending;
    let mut changes = transaction(&snapshot.session);
    changes.elicitations = vec![reopened.clone()];
    changes.events = vec![event(session.id, EventKind::Elicitation, &reopened)];
    assert!(matches!(
        local.agent_commit(changes).await,
        Err(StoreError::InvalidAgent("elicitation was already resolved"))
    ));
    local.close().await.unwrap();
}

#[tokio::test]
async fn concurrent_question_responses_keep_one_winner_and_immutable_audit() {
    let file = File::new();
    let local = LocalCatalog::open(&file.0, "host").await.unwrap();
    let session = create(&local).await.session;
    let pending = question(&local, session.id).await;
    let mut changes = transaction(&session);
    changes.runs = vec![run(session.id, 1)];
    changes.elicitations = vec![pending.clone()];
    changes.events = vec![event(session.id, EventKind::Elicitation, &pending)];
    let current = local.agent_commit(changes).await.unwrap().session.unwrap();
    let mut accept = command(&local, Some(current.id)).await;
    accept.method = "elicitation/respond".into();
    accept.params = parse(json!({
        "elicitationId": pending.id,
        "response": {"action": "accept", "content": {"scope": "full"}}
    }));
    let mut decline = command(&local, Some(current.id)).await;
    decline.method = "elicitation/respond".into();
    decline.params = parse(json!({
        "elicitationId": pending.id, "response": {"action": "decline"}
    }));
    let accepted = AgentElicitation {
        state: ElicitationState::Resolved,
        response: Some(accept.params["response"].clone()),
        decision_command_id: Some(accept.id),
        actor: Some(accept.actor.clone()),
        resolved_at: Some(TIME.into()),
        ..pending.clone()
    };
    let declined = AgentElicitation {
        response: Some(decline.params["response"].clone()),
        decision_command_id: Some(decline.id),
        actor: Some(decline.actor.clone()),
        ..accepted.clone()
    };
    let mut first = transaction(&current);
    first.command = Some(accept.clone());
    first.elicitations = vec![accepted.clone()];
    first.events = vec![event(current.id, EventKind::Elicitation, &accepted)];
    let mut second = transaction(&current);
    second.command = Some(decline.clone());
    second.elicitations = vec![declined.clone()];
    second.events = vec![event(current.id, EventKind::Elicitation, &declined)];
    let (one, two) = tokio::join!(local.agent_commit(first), local.agent_commit(second));
    assert_ne!(one.is_ok(), two.is_ok());
    let (winner, loser, resolved, alternative) = if one.is_ok() {
        (accept, decline, accepted, declined)
    } else {
        (decline, accept, declined, accepted)
    };
    let snapshot = local.agent_snapshot(current.id).await.unwrap().unwrap();
    assert_eq!(snapshot.elicitations, [resolved]);
    assert_eq!(snapshot.session.last_event_seq.as_i64(), 2);
    assert_eq!(
        local.agent_command(&winner.operation_id).await.unwrap(),
        Some(winner.clone())
    );
    assert_eq!(
        local.agent_command(&loser.operation_id).await.unwrap(),
        None
    );

    let mut retry = transaction(&snapshot.session);
    retry.command = Some(loser.clone());
    retry.elicitations = vec![alternative.clone()];
    retry.events = vec![event(current.id, EventKind::Elicitation, &alternative)];
    assert!(matches!(
        local.agent_commit(retry).await,
        Err(StoreError::InvalidAgent("elicitation was already resolved"))
    ));
    assert_eq!(
        local.agent_command(&loser.operation_id).await.unwrap(),
        None
    );
    local.delete_workspace_session(current.id).await.unwrap();
    assert!(local.agent_snapshot(current.id).await.unwrap().is_none());
    assert_eq!(
        local.agent_command(&winner.operation_id).await.unwrap(),
        Some(winner)
    );
    local.close().await.unwrap();
}

#[tokio::test]
async fn question_request_is_immutable_and_invalid_links_roll_back_the_transaction() {
    let file = File::new();
    let local = LocalCatalog::open(&file.0, "host").await.unwrap();
    let session = create(&local).await.session;
    let pending = question(&local, session.id).await;
    let mut changes = transaction(&session);
    changes.elicitations = vec![pending.clone()];
    assert!(local.agent_commit(changes.clone()).await.is_err());
    changes.events = vec![event(session.id, EventKind::Elicitation, &pending)];
    // The question cannot refer to a run that was never committed.
    assert!(local.agent_commit(changes.clone()).await.is_err());
    assert_eq!(
        local
            .agent_snapshot(session.id)
            .await
            .unwrap()
            .unwrap()
            .session
            .last_event_seq
            .as_i64(),
        0
    );
    changes.runs = vec![run(session.id, 1)];
    let current = local.agent_commit(changes).await.unwrap().session.unwrap();
    let mut changed = pending.clone();
    changed.request["message"] = json!("A replacement question");
    let mut changes = transaction(&current);
    changes.elicitations = vec![changed.clone()];
    changes.events = vec![event(session.id, EventKind::Elicitation, &changed)];
    assert!(matches!(
        local.agent_commit(changes).await,
        Err(StoreError::InvalidAgent(
            "elicitation identity and request are immutable"
        ))
    ));

    let other = create(&local).await.session;
    let foreign = command(&local, Some(other.id)).await;
    local
        .agent_commit(AgentCommit {
            command: Some(foreign.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    let response = AgentElicitation {
        state: ElicitationState::Resolved,
        response: Some(json!({"action": "accept", "content": {"scope": "full"}})),
        decision_command_id: Some(foreign.id),
        actor: Some(foreign.actor),
        resolved_at: Some(TIME.into()),
        ..pending.clone()
    };
    let mut changes = transaction(&current);
    changes.elicitations = vec![response.clone()];
    changes.events = vec![event(session.id, EventKind::Elicitation, &response)];
    assert!(matches!(
        local.agent_commit(changes).await,
        Err(StoreError::InvalidAgent(
            "linked command belongs to another session"
        ))
    ));
    let snapshot = local.agent_snapshot(session.id).await.unwrap().unwrap();
    assert_eq!(snapshot.elicitations, [pending]);
    assert_eq!(snapshot.session, current);
    local.close().await.unwrap();
}
