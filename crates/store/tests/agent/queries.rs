use super::*;

#[tokio::test]
async fn session_metadata_tracks_commits_and_disappears_on_deletion() {
    let local = LocalCatalog::open_in_memory("metadata").await.unwrap();
    let created = create(&local).await;
    assert_eq!(
        local.agent_session(created.session.id).await.unwrap(),
        Some(created.session.clone())
    );
    let mut changes = transaction(&created.session);
    let running = run(created.session.id, 1);
    changes.runs = vec![running.clone()];
    changes.events = vec![event(created.session.id, EventKind::Run, running)];
    local.agent_commit(changes).await.unwrap();
    let snapshot = local
        .agent_snapshot(created.session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.session.last_event_seq.as_i64(), 1);
    assert_eq!(
        local.agent_session(created.session.id).await.unwrap(),
        Some(snapshot.session)
    );
    local
        .delete_workspace_session(created.session.id)
        .await
        .unwrap();
    assert!(
        local
            .agent_session(created.session.id)
            .await
            .unwrap()
            .is_none()
    );
    local.close().await.unwrap();
}

#[tokio::test]
async fn noncanonical_or_unrelated_delete_receipts_do_not_release_admission() {
    let local = LocalCatalog::open_in_memory("receipts").await.unwrap();
    let mut creation = command(&local, None).await;
    creation.method = "_deskfleet/session/create".into();
    let operation_id = creation.operation_id.clone();
    let created = local
        .agent_create_session(AgentCreateSession {
            command: creation,
            workspace_id: None,
            provider: "codex".into(),
            title: "Quota".into(),
            context: SessionContext::Directory,
            inherited_turn_count: 0,
            admission_generation: Some(operation_id.clone()),
        })
        .await
        .unwrap();
    let unrelated = create(&local).await;
    let mut rejected = command(&local, Some(created.session.id)).await;
    rejected.method = "_deskfleet/session/delete".into();
    rejected.is_canonical = false;
    rejected.status = CommandStatus::Rejected;
    let mut other = command(&local, Some(unrelated.session.id)).await;
    other.method = "_deskfleet/session/delete".into();
    for receipt in [rejected, other] {
        local
            .agent_commit(AgentCommit {
                command: Some(receipt),
                ..Default::default()
            })
            .await
            .unwrap();
    }
    for id in [created.session.id, unrelated.session.id] {
        local.delete_workspace_session(id).await.unwrap();
    }
    assert!(!local.agent_admission_deleted(&operation_id).await.unwrap());
    let mut canonical = command(&local, Some(created.session.id)).await;
    canonical.method = "_deskfleet/session/delete".into();
    local
        .agent_commit(AgentCommit {
            command: Some(canonical),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(local.agent_admission_deleted(&operation_id).await.unwrap());
    local.close().await.unwrap();
}

#[tokio::test]
async fn command_revision_tracks_receipt_only_changes_and_survives_restart() {
    let file = File::new();
    let local = LocalCatalog::open(&file.0, "revisions").await.unwrap();
    let created = create(&local).await;
    let id = created.session.id;
    let (commands, first) = local.agent_commands_since(id, -1).await.unwrap();
    assert_eq!(commands, vec![created.command.clone()]);
    assert!(first > 0);
    assert_eq!(
        local.agent_commands_since(id, first).await.unwrap(),
        (vec![], first)
    );

    let mut receipt = command(&local, Some(id)).await;
    local
        .agent_commit(AgentCommit {
            command: Some(receipt.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    let (commands, accepted) = local.agent_commands_since(id, first).await.unwrap();
    assert_eq!(commands, vec![receipt.clone()]);
    assert!(accepted > first);
    assert_eq!(
        local
            .agent_session(id)
            .await
            .unwrap()
            .unwrap()
            .last_event_seq
            .as_i64(),
        0
    );
    create(&local).await; // A different Session's revision must not move this cursor.
    assert_eq!(
        local.agent_commands_since(id, accepted).await.unwrap(),
        (vec![], accepted)
    );

    receipt.status = CommandStatus::Completed;
    receipt.completed_at = Some(TIME.into());
    local
        .agent_commit(AgentCommit {
            command: Some(receipt.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    local.close().await.unwrap();
    let local = LocalCatalog::open(&file.0, "revisions").await.unwrap();
    let (commands, completed) = local.agent_commands_since(id, accepted).await.unwrap();
    assert_eq!(commands, vec![receipt]);
    assert!(completed > accepted);
    assert_eq!(
        local.agent_commands_since(id, completed).await.unwrap(),
        (vec![], completed)
    );
    assert!(local.agent_commands_since(id, -2).await.is_err());
    local.close().await.unwrap();
}
