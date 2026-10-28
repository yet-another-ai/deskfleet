use std::path::PathBuf;

use deskfleet_model::{AgentSessionId, DirectoryBinding, DirectoryBindings, agent::*};
use deskfleet_store::{LocalCatalog, StoreError};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

#[path = "agent/elicitations.rs"]
mod elicitations;

struct File(PathBuf);
impl File {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("deskfleet-agent-{}.sqlite", uuid::Uuid::new_v4())))
    }
}
impl Drop for File {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn parse<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}
const TIME: &str = "2026-10-23T00:00:00.000Z";

async fn command(local: &LocalCatalog, session: Option<AgentSessionId>) -> AgentCommand {
    let identity = local.agent_identity().await.unwrap();
    parse(json!({
        "id": local.agent_allocate_id().await.unwrap().to_string(),
        "operationId": uuid::Uuid::new_v4().to_string(),
        "actor": {"kind": "local_token", "sourceMachine": {"originId": identity.origin_id, "id": identity.machine_id}},
        "sessionId": session, "method": "input/submit", "params": {"text": "hello"},
        "isCanonical": true, "status": "accepted", "receivedAt": TIME,
    }))
}
async fn create(local: &LocalCatalog) -> AgentCreatedSession {
    let workspace = local
        .create_workspace(
            "workspace",
            DirectoryBindings::new(vec![DirectoryBinding {
                path: "/repo".into(),
            }])
            .unwrap(),
        )
        .await
        .unwrap();
    let mut command = command(local, None).await;
    command.method = "session/create".into();
    local
        .agent_create_session(AgentCreateSession {
            command,
            workspace_id: Some(workspace.workspace.id),
            provider: "codex".into(),
            title: "Test".into(),
            context: SessionContext::Worktree,
            inherited_turn_count: 0,
            admission_generation: None,
        })
        .await
        .unwrap()
}
fn event(
    session: AgentSessionId,
    kind: EventKind,
    payload: impl serde::Serialize,
) -> AgentEventDraft {
    AgentEventDraft {
        session_id: session,
        kind,
        payload: serde_json::to_value(payload).unwrap(),
        created_at: TIME.into(),
        turn_id: None,
        input_id: None,
        command_id: None,
        run_generation: None,
    }
}
fn transaction(session: &AgentSessionRecord) -> AgentCommit {
    AgentCommit {
        session_id: Some(session.id),
        expected_seq: Some(session.last_event_seq),
        ..Default::default()
    }
}
fn run(session: AgentSessionId, generation: u64) -> AgentRun {
    AgentRun {
        session_id: session,
        generation,
        state: RunState::Running,
        started_at: TIME.into(),
        ended_at: None,
        error: None,
    }
}
async fn input(local: &LocalCatalog, command: &AgentCommand, seq: i64) -> AgentInput {
    parse(json!({
        "id": local.agent_allocate_id().await.unwrap().to_string(), "sessionId": command.session_id,
        "submissionCommandId": command.id, "author": command.actor, "content": [{"type": "text", "text": "hello"}],
        "acceptedSeq": seq.to_string(), "state": "pending", "requestedDelivery": "backlog", "createdAt": TIME,
    }))
}

#[tokio::test]
async fn identity_allocator_and_atomic_creation_survive_restart() {
    let file = File::new();
    let local = LocalCatalog::open(&file.0, "host").await.unwrap();
    let identity = local.agent_identity().await.unwrap();
    let created = create(&local).await;
    assert_eq!(
        created.command.result,
        Some(json!({"sessionId": created.session.id}))
    );
    assert_eq!(created.command.session_id, Some(created.session.id));
    assert_eq!(created.session.lifecycle, SessionLifecycle::Provisioning);
    assert_eq!(created.session.last_event_seq.as_i64(), 0);
    assert_eq!(
        local.snapshot().await.unwrap().workspaces[0]
            .worktrees
            .len(),
        1
    );
    let mut duplicate = created.command.clone();
    duplicate.id = local.agent_allocate_id().await.unwrap().into();
    duplicate.session_id = None;
    let duplicate_id = duplicate.id.as_i64();
    assert!(
        local
            .agent_create_session(AgentCreateSession {
                command: duplicate,
                workspace_id: created.session.workspace_id,
                provider: "codex".into(),
                title: "duplicate".into(),
                context: SessionContext::Worktree,
                inherited_turn_count: 0,
                admission_generation: None,
            })
            .await
            .is_err()
    );
    assert_eq!(
        local.agent_list().await.unwrap(),
        vec![created.session.clone()]
    );
    local.close().await.unwrap();
    let local = LocalCatalog::open(&file.0, "renamed-host").await.unwrap();
    assert_eq!(local.agent_identity().await.unwrap(), identity);
    assert!(local.agent_allocate_id().await.unwrap() > duplicate_id);
    assert_eq!(
        local
            .agent_command(&created.command.operation_id)
            .await
            .unwrap(),
        Some(created.command)
    );
    assert_eq!(
        local
            .agent_snapshot(created.session.id)
            .await
            .unwrap()
            .unwrap()
            .session,
        created.session
    );
    // A duplicate create must not leave an unextended catalog Session behind.
    local
        .delete_workspace_session(created.session.id)
        .await
        .unwrap();
    local
        .delete_workspace(created.session.workspace_id.unwrap())
        .await
        .unwrap();
    local.close().await.unwrap();
}

#[tokio::test]
async fn state_and_ordered_events_commit_atomically_and_replay_after_restart() {
    let file = File::new();
    let local = LocalCatalog::open(&file.0, "host").await.unwrap();
    let created = create(&local).await;
    let command = command(&local, Some(created.session.id)).await;
    let input = input(&local, &command, 2).await;
    let run = run(created.session.id, 1);
    let mut commit = transaction(&created.session);
    commit.session = Some(AgentSessionRecord {
        lifecycle: SessionLifecycle::Ready,
        title: "Customized title".into(),
        title_customized: true,
        ..created.session.clone()
    });
    commit.runs = vec![run.clone()];
    commit.inputs = vec![input.clone()];
    commit.command = Some(command.clone());
    commit.events = vec![
        event(created.session.id, EventKind::Run, &run),
        event(created.session.id, EventKind::Input, &input),
        event(created.session.id, EventKind::Session, &created.session),
    ];
    let result = local.agent_commit(commit.clone()).await.unwrap();
    assert_eq!(
        result
            .events
            .iter()
            .map(|e| e.seq.as_i64())
            .collect::<Vec<_>>(),
        [1, 2, 3]
    );
    assert_eq!(result.events[2].event.payload["lastEventSeq"], "3");
    assert_eq!(result.events[2].event.payload["lifecycle"], "ready");
    assert_eq!(result.session.as_ref().unwrap().last_event_seq.as_i64(), 3);
    assert!(matches!(
        local.agent_commit(commit).await,
        Err(StoreError::AgentConflict {
            expected: 0,
            actual: 3
        })
    ));
    let snapshot = local
        .agent_snapshot(created.session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.inputs, [input]);
    assert_eq!(snapshot.runs, [run]);
    assert_eq!(snapshot.session.title, "Customized title");
    assert!(snapshot.session.title_customized);
    local.close().await.unwrap();
    let local = LocalCatalog::open(&file.0, "host").await.unwrap();
    assert_eq!(
        local.agent_snapshot(created.session.id).await.unwrap(),
        Some(snapshot)
    );
    assert_eq!(
        local
            .agent_history(created.session.id, 1.into(), 1)
            .await
            .unwrap(),
        result.events[1..2]
    );
    assert_eq!(
        local
            .agent_history(created.session.id, 3.into(), 10)
            .await
            .unwrap(),
        []
    );
    local.close().await.unwrap();
}

#[tokio::test]
async fn failed_foreign_key_rolls_back_command_state_and_sequence() {
    let local = LocalCatalog::open_in_memory("host").await.unwrap();
    let created = create(&local).await;
    let command = command(&local, Some(created.session.id)).await;
    let run = run(created.session.id, 1);
    let mut commit = transaction(&created.session);
    commit.runs = vec![run.clone()];
    commit.command = Some(command.clone());
    assert!(local.agent_commit(commit.clone()).await.is_err());
    let mut invalid = event(created.session.id, EventKind::Run, &run);
    invalid.turn_id = Some(999.into());
    commit.events = vec![invalid];
    assert!(local.agent_commit(commit).await.is_err());
    assert_eq!(
        local.agent_command(&command.operation_id).await.unwrap(),
        None
    );
    let snapshot = local
        .agent_snapshot(created.session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.session.last_event_seq.as_i64(), 0);
    assert!(snapshot.runs.is_empty());
    assert!(
        local
            .agent_history(created.session.id, 0.into(), 10)
            .await
            .unwrap()
            .is_empty()
    );
    local.close().await.unwrap();
}

#[tokio::test]
async fn active_run_constraint_and_same_session_links_are_enforced() {
    let local = LocalCatalog::open_in_memory("host").await.unwrap();
    let first = create(&local).await.session;
    let second = create(&local).await.session;
    let mut commit = transaction(&first);
    commit.runs = vec![run(first.id, 1), run(first.id, 2)];
    commit.events = vec![event(first.id, EventKind::Run, &commit.runs[0])];
    assert!(local.agent_commit(commit).await.is_err());
    let command = command(&local, Some(second.id)).await;
    local
        .agent_commit(AgentCommit {
            command: Some(command.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    let mut input = input(&local, &command, 1).await;
    input.session_id = first.id;
    let mut commit = transaction(&first);
    commit.inputs = vec![input.clone()];
    commit.events = vec![event(first.id, EventKind::Input, input)];
    assert!(local.agent_commit(commit).await.is_err());
    assert!(
        local
            .agent_snapshot(first.id)
            .await
            .unwrap()
            .unwrap()
            .inputs
            .is_empty()
    );
    local.close().await.unwrap();
}

#[tokio::test]
async fn deletion_cascades_domain_records_but_preserves_audit_targets() {
    let local = LocalCatalog::open_in_memory("host").await.unwrap();
    let created = create(&local).await;
    let command = command(&local, Some(created.session.id)).await;
    let input = input(&local, &command, 1).await;
    let mut commit = transaction(&created.session);
    commit.command = Some(command.clone());
    commit.inputs = vec![input.clone()];
    commit.events = vec![event(created.session.id, EventKind::Input, &input)];
    local.agent_commit(commit).await.unwrap();
    local
        .attach_session_worktree(
            created.session.id,
            DirectoryBindings::new(vec![DirectoryBinding {
                path: "/managed/repo".into(),
            }])
            .unwrap(),
        )
        .await
        .unwrap();
    local
        .delete_workspace_session(created.session.id)
        .await
        .unwrap();
    local
        .delete_workspace(created.session.workspace_id.unwrap())
        .await
        .unwrap();
    assert_eq!(
        local.agent_snapshot(created.session.id).await.unwrap(),
        None
    );
    assert!(local.agent_list().await.unwrap().is_empty());
    assert_eq!(
        local.agent_command(&command.operation_id).await.unwrap(),
        Some(command.clone())
    );
    let completed = AgentCommand {
        status: CommandStatus::Completed,
        result: Some(Value::Null),
        completed_at: Some(TIME.into()),
        ..command
    };
    local
        .agent_commit(AgentCommit {
            command: Some(completed.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        local.agent_command(&completed.operation_id).await.unwrap(),
        Some(completed)
    );
    local.close().await.unwrap();
}

#[tokio::test]
async fn canonical_operation_and_immutable_request_preserve_audit() {
    let local = LocalCatalog::open_in_memory("host").await.unwrap();
    let command = command(&local, None).await;
    local
        .agent_commit(AgentCommit {
            command: Some(command.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    let mut duplicate = command.clone();
    duplicate.id = local.agent_allocate_id().await.unwrap().into();
    assert!(
        local
            .agent_commit(AgentCommit {
                command: Some(duplicate.clone()),
                ..Default::default()
            })
            .await
            .is_err()
    );
    duplicate.is_canonical = false;
    duplicate.status = CommandStatus::Rejected;
    duplicate.conflicting_command_id = Some(command.id);
    duplicate
        .params
        .insert("text".into(), json!("different payload"));
    local
        .agent_commit(AgentCommit {
            command: Some(duplicate),
            ..Default::default()
        })
        .await
        .unwrap();
    let mut changed = command.clone();
    changed.params.clear();
    assert!(
        local
            .agent_commit(AgentCommit {
                command: Some(changed),
                ..Default::default()
            })
            .await
            .is_err()
    );
    assert_eq!(
        local.agent_command(&command.operation_id).await.unwrap(),
        Some(command)
    );
    local.close().await.unwrap();
}

#[tokio::test]
async fn failed_input_can_have_another_turn_attempt_but_only_one_active_turn() {
    let local = LocalCatalog::open_in_memory("host").await.unwrap();
    let created = create(&local).await;
    let submission = command(&local, Some(created.session.id)).await;
    let input = input(&local, &submission, 1).await;
    let run = run(created.session.id, 1);
    let mut changes = transaction(&created.session);
    changes.command = Some(submission);
    changes.runs = vec![run];
    changes.inputs = vec![input.clone()];
    changes.events = vec![event(created.session.id, EventKind::Input, &input)];
    let current = local.agent_commit(changes).await.unwrap().session.unwrap();
    let dispatch = command(&local, Some(current.id)).await;
    let first = AgentTurn {
        id: local.agent_allocate_id().await.unwrap().into(),
        session_id: current.id,
        initial_input_id: input.id,
        dispatch_command_id: dispatch.id,
        run_generation: 1,
        state: TurnState::Running,
        consumed: true,
        started_at: TIME.into(),
        ended_at: None,
        stop_reason: None,
        error: None,
    };
    let mut changes = transaction(&current);
    changes.command = Some(dispatch);
    changes.turns = vec![first.clone()];
    changes.events = vec![event(current.id, EventKind::Turn, &first)];
    let current = local.agent_commit(changes).await.unwrap().session.unwrap();
    let mut unconsumed = first.clone();
    unconsumed.consumed = false;
    let mut changes = transaction(&current);
    changes.turns = vec![unconsumed];
    assert!(
        local.agent_commit(changes).await.is_err(),
        "consumed usage cannot be erased"
    );
    let mut changed_baseline = current.clone();
    changed_baseline.inherited_turn_count += 1;
    let mut changes = transaction(&current);
    changes.session = Some(changed_baseline);
    assert!(
        local.agent_commit(changes).await.is_err(),
        "fork baseline is immutable"
    );
    let next_dispatch = command(&local, Some(current.id)).await;
    let second = AgentTurn {
        id: local.agent_allocate_id().await.unwrap().into(),
        dispatch_command_id: next_dispatch.id,
        ..first.clone()
    };
    let mut changes = transaction(&current);
    changes.command = Some(next_dispatch.clone());
    changes.turns = vec![second.clone()];
    changes.events = vec![event(current.id, EventKind::Turn, &second)];
    assert!(local.agent_commit(changes).await.is_err());
    assert_eq!(
        local
            .agent_command(&next_dispatch.operation_id)
            .await
            .unwrap(),
        None
    );
    let failed = AgentTurn {
        state: TurnState::Failed,
        ended_at: Some(TIME.into()),
        ..first
    };
    let mut changes = transaction(&current);
    changes.turns = vec![failed.clone()];
    changes.events = vec![event(current.id, EventKind::Turn, &failed)];
    let current = local.agent_commit(changes).await.unwrap().session.unwrap();
    let mut changes = transaction(&current);
    changes.command = Some(next_dispatch);
    changes.turns = vec![second.clone()];
    changes.events = vec![event(current.id, EventKind::Turn, &second)];
    local.agent_commit(changes).await.unwrap();
    assert_eq!(
        local
            .agent_snapshot(current.id)
            .await
            .unwrap()
            .unwrap()
            .turns,
        [failed, second]
    );
    local.delete_workspace_session(current.id).await.unwrap();
    local.close().await.unwrap();
}

#[tokio::test]
async fn concurrent_permission_decisions_commit_only_the_first_and_preserve_audit() {
    let local = LocalCatalog::open_in_memory("host").await.unwrap();
    let session = create(&local).await.session;
    let permission: AgentPermission = parse(json!({
        "id": local.agent_allocate_id().await.unwrap().to_string(), "sessionId": session.id,
        "runGeneration": 1, "request": {"toolCall": {"toolCallId": "call-1"}, "options": [{"optionId": "allow", "kind": "allow_once", "name": "Allow"}]},
        "state": "pending", "createdAt": TIME,
    }));
    let mut changes = transaction(&session);
    changes.runs = vec![run(session.id, 1)];
    changes.permissions = vec![permission.clone()];
    changes.events = vec![event(session.id, EventKind::Permission, &permission)];
    let current = local.agent_commit(changes).await.unwrap().session.unwrap();
    let allow = command(&local, Some(current.id)).await;
    let cancel = command(&local, Some(current.id)).await;
    let resolved = AgentPermission {
        state: PermissionState::Resolved,
        decision_command_id: Some(allow.id),
        option_id: Some("allow".into()),
        actor: Some(allow.actor.clone()),
        resolved_at: Some(TIME.into()),
        ..permission.clone()
    };
    let cancelled = AgentPermission {
        state: PermissionState::Cancelled,
        decision_command_id: Some(cancel.id),
        actor: Some(cancel.actor.clone()),
        resolved_at: Some(TIME.into()),
        ..permission
    };
    let mut first = transaction(&current);
    first.command = Some(allow.clone());
    first.permissions = vec![resolved.clone()];
    first.events = vec![event(current.id, EventKind::Permission, &resolved)];
    let mut second = transaction(&current);
    second.command = Some(cancel.clone());
    second.permissions = vec![cancelled.clone()];
    second.events = vec![event(current.id, EventKind::Permission, &cancelled)];
    let (one, two) = tokio::join!(local.agent_commit(first), local.agent_commit(second));
    assert_ne!(one.is_ok(), two.is_ok());
    let snapshot = local.agent_snapshot(current.id).await.unwrap().unwrap();
    assert_eq!(snapshot.session.last_event_seq.as_i64(), 2);
    let (winner, loser, alternative) = if one.is_ok() {
        (&allow, &cancel, cancelled)
    } else {
        (&cancel, &allow, resolved)
    };
    assert_eq!(snapshot.permissions[0].decision_command_id, Some(winner.id));
    assert!(
        local
            .agent_command(&winner.operation_id)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        local
            .agent_command(&loser.operation_id)
            .await
            .unwrap()
            .is_none()
    );
    let mut retry = transaction(&snapshot.session);
    retry.command = Some(loser.clone());
    retry.permissions = vec![alternative.clone()];
    retry.events = vec![event(current.id, EventKind::Permission, &alternative)];
    assert!(local.agent_commit(retry).await.is_err());
    local.delete_workspace_session(current.id).await.unwrap();
    assert!(
        local
            .agent_command(&winner.operation_id)
            .await
            .unwrap()
            .is_some()
    );
    local.close().await.unwrap();
}

#[tokio::test]
async fn session_context_is_recorded_at_creation_and_immutable() {
    let local = LocalCatalog::open_in_memory("host").await.unwrap();
    let created = create(&local).await;
    assert_eq!(created.session.context, SessionContext::Worktree);
    let mut commit = transaction(&created.session);
    commit.session = Some(AgentSessionRecord {
        context: SessionContext::Directory,
        ..created.session.clone()
    });
    assert!(local.agent_commit(commit).await.is_err());
    let stored: AgentSessionRecord = parse(
        json!({"id": "1", "workspaceId": "1", "provider": "codex", "title": "", "lifecycle": "ready", "lastEventSeq": "0", "createdAt": TIME, "updatedAt": TIME}),
    );
    assert_eq!(
        stored.context,
        SessionContext::Worktree,
        "records without a context used a worktree"
    );
    local.close().await.unwrap();
}

#[tokio::test]
async fn archive_state_and_browser_audit_persist_without_losing_the_owned_context() {
    let file = File::new();
    let local = LocalCatalog::open(&file.0, "host").await.unwrap();
    let created = create(&local).await;
    let worktree = local
        .attach_session_worktree(
            created.session.id,
            DirectoryBindings::new(vec![DirectoryBinding {
                path: "/retained-worktree".into(),
            }])
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(created.session.archive_state, ArchiveState::Active);
    let mut archive = command(&local, Some(created.session.id)).await;
    archive.method = "_deskfleet/session/archive".into();
    archive.actor = AgentActor {
        kind: ActorKind::User,
        user_id: Some("alice".into()),
        device_id: Some("browser".into()),
        source_machine: None,
    };
    let mut session = created.session;
    for state in [ArchiveState::Archiving, ArchiveState::Archived] {
        let mut commit = transaction(&session);
        session.archive_state = state;
        session.lifecycle = SessionLifecycle::Ready;
        commit.session = Some(session.clone());
        commit.command = Some(archive.clone());
        commit.events = vec![event(session.id, EventKind::Session, &session)];
        session = local.agent_commit(commit).await.unwrap().session.unwrap();
    }
    archive.status = CommandStatus::Completed;
    archive.completed_at = Some(TIME.into());
    let mut commit = transaction(&session);
    commit.command = Some(archive.clone());
    commit.events = vec![event(session.id, EventKind::Command, &archive)];
    session = local.agent_commit(commit).await.unwrap().session.unwrap();
    let history = local
        .agent_history(session.id, 0.into(), 100)
        .await
        .unwrap();
    let commands = local.agent_commands(session.id).await.unwrap();
    assert_eq!(commands.len(), 2);
    assert_eq!(commands.last(), Some(&archive));
    assert!(
        serde_json::to_value(&archive.actor)
            .unwrap()
            .get("sourceMachine")
            .is_none()
    );
    assert!(matches!(
        local.delete_workspace(session.workspace_id.unwrap()).await,
        Err(StoreError::WorkspaceHasSessions { .. })
    ));
    local.close().await.unwrap();

    let local = LocalCatalog::open(&file.0, "host").await.unwrap();
    assert_eq!(
        local
            .agent_snapshot(session.id)
            .await
            .unwrap()
            .unwrap()
            .session,
        session
    );
    assert_eq!(
        local
            .agent_history(session.id, 0.into(), 100)
            .await
            .unwrap(),
        history
    );
    assert_eq!(local.agent_commands(session.id).await.unwrap(), commands);
    assert!(
        local.snapshot().await.unwrap().workspaces[0]
            .worktrees
            .contains(&worktree)
    );
    let mut restore = transaction(&session);
    session.archive_state = ArchiveState::Active;
    restore.session = Some(session.clone());
    restore.events = vec![event(session.id, EventKind::Session, &session)];
    local.agent_commit(restore).await.unwrap();
    let restored = local.agent_snapshot(session.id).await.unwrap().unwrap();
    assert_eq!(restored.session.archive_state, ArchiveState::Active);
    assert!(restored.runs.is_empty());
    assert_eq!(local.agent_commands(session.id).await.unwrap(), commands);
    local.close().await.unwrap();
}

#[tokio::test]
async fn admission_deletion_requires_a_local_creation_and_deletion_receipt() {
    let local = LocalCatalog::open_in_memory("host").await.unwrap();
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
            inherited_turn_count: 7,
            admission_generation: Some(operation_id.clone()),
        })
        .await
        .unwrap();
    assert!(!local.agent_admission_deleted(&operation_id).await.unwrap());
    let mut deletion = command(&local, Some(created.session.id)).await;
    deletion.method = "_deskfleet/session/delete".into();
    local
        .agent_commit(AgentCommit {
            command: Some(deletion),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(!local.agent_admission_deleted(&operation_id).await.unwrap());
    local
        .delete_workspace_session(created.session.id)
        .await
        .unwrap();
    assert!(local.agent_admission_deleted(&operation_id).await.unwrap());
    assert!(
        !local
            .agent_admission_deleted(&uuid::Uuid::new_v4().to_string())
            .await
            .unwrap()
    );
    local.close().await.unwrap();
}
