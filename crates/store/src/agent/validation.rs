use deskfleet_model::{AgentSessionId, agent::*};
use sea_orm::ConnectionTrait;

use super::sql::{generation, positive, record};
use crate::StoreError;

pub(super) fn same_session(
    expected: AgentSessionId,
    actual: AgentSessionId,
) -> Result<(), StoreError> {
    if expected != actual {
        return Err(StoreError::InvalidAgent(
            "records must belong to the transaction session",
        ));
    }
    Ok(())
}

pub(super) async fn command(
    db: &impl ConnectionTrait,
    value: &AgentCommand,
) -> Result<(), StoreError> {
    positive(value.id.as_i64())?;
    if uuid::Uuid::parse_str(&value.operation_id).is_err() {
        return Err(StoreError::InvalidAgent("operation ID must be a UUID"));
    }
    if let Some(previous) = record::<AgentCommand>(
        db,
        "SELECT record_json FROM agent_commands WHERE id = ?",
        vec![value.id.as_i64().into()],
    )
    .await?
        && (previous.operation_id != value.operation_id
            || previous.actor != value.actor
            || previous.session_id != value.session_id
            || previous.workspace_id != value.workspace_id
            || previous.method != value.method
            || previous.params != value.params
            || previous.is_canonical != value.is_canonical
            || previous.conflicting_command_id != value.conflicting_command_id
            || previous.received_at != value.received_at)
    {
        return Err(StoreError::InvalidAgent(
            "command identity and request are immutable",
        ));
    }
    Ok(())
}

pub(super) async fn run(db: &impl ConnectionTrait, value: &AgentRun) -> Result<(), StoreError> {
    let previous: Option<AgentRun> = record(
        db,
        "SELECT record_json FROM agent_runs WHERE session_id = ? AND generation = ?",
        vec![
            value.session_id.as_i64().into(),
            generation(value.generation)?.into(),
        ],
    )
    .await?;
    if previous.is_some_and(|old| old.started_at != value.started_at) {
        return Err(StoreError::InvalidAgent("run start is immutable"));
    }
    Ok(())
}

pub(super) async fn input(db: &impl ConnectionTrait, value: &AgentInput) -> Result<(), StoreError> {
    positive(value.id.as_i64())?;
    positive(value.accepted_seq.as_i64())?;
    if let Some(old) = record::<AgentInput>(
        db,
        "SELECT record_json FROM agent_inputs WHERE id = ?",
        vec![value.id.as_i64().into()],
    )
    .await?
        && (old.session_id != value.session_id
            || old.submission_command_id != value.submission_command_id
            || old.author != value.author
            || old.content != value.content
            || old.accepted_seq != value.accepted_seq
            || old.created_at != value.created_at)
    {
        return Err(StoreError::InvalidAgent(
            "input identity and submission are immutable",
        ));
    }
    command_session(db, value.submission_command_id.as_i64(), value.session_id).await?;
    if let Some(command) = value.dispatch_command_id {
        command_session(db, command.as_i64(), value.session_id).await?;
    }
    Ok(())
}

pub(super) async fn turn(db: &impl ConnectionTrait, value: &AgentTurn) -> Result<(), StoreError> {
    positive(value.id.as_i64())?;
    if let Some(old) = record::<AgentTurn>(
        db,
        "SELECT record_json FROM agent_turns WHERE id = ?",
        vec![value.id.as_i64().into()],
    )
    .await?
        && (old.session_id != value.session_id
            || old.initial_input_id != value.initial_input_id
            || old.dispatch_command_id != value.dispatch_command_id
            || old.run_generation != value.run_generation
            || old.started_at != value.started_at)
    {
        return Err(StoreError::InvalidAgent(
            "turn identity and attempt are immutable",
        ));
    }
    command_session(db, value.dispatch_command_id.as_i64(), value.session_id).await
}

pub(super) async fn permission(
    db: &impl ConnectionTrait,
    value: &AgentPermission,
) -> Result<(), StoreError> {
    positive(value.id.as_i64())?;
    if let Some(old) = record::<AgentPermission>(
        db,
        "SELECT record_json FROM agent_permissions WHERE id = ?",
        vec![value.id.as_i64().into()],
    )
    .await?
    {
        if old.session_id != value.session_id
            || old.run_generation != value.run_generation
            || old.turn_id != value.turn_id
            || old.request != value.request
            || old.created_at != value.created_at
        {
            return Err(StoreError::InvalidAgent(
                "permission identity and request are immutable",
            ));
        }
        if old.state != PermissionState::Pending && old != *value {
            return Err(StoreError::InvalidAgent("permission was already resolved"));
        }
    }
    if let Some(command) = value.decision_command_id {
        command_session(db, command.as_i64(), value.session_id).await?;
    }
    Ok(())
}

pub(super) async fn elicitation(
    db: &impl ConnectionTrait,
    value: &AgentElicitation,
) -> Result<(), StoreError> {
    positive(value.id.as_i64())?;
    if let Some(old) = record::<AgentElicitation>(
        db,
        "SELECT record_json FROM agent_elicitations WHERE id = ?",
        vec![value.id.as_i64().into()],
    )
    .await?
    {
        if old.session_id != value.session_id
            || old.run_generation != value.run_generation
            || old.turn_id != value.turn_id
            || old.request != value.request
            || old.created_at != value.created_at
        {
            return Err(StoreError::InvalidAgent(
                "elicitation identity and request are immutable",
            ));
        }
        if old.state != ElicitationState::Pending && old != *value {
            return Err(StoreError::InvalidAgent("elicitation was already resolved"));
        }
    }
    if let Some(command) = value.decision_command_id {
        command_session(db, command.as_i64(), value.session_id).await?;
    }
    Ok(())
}

pub(super) async fn command_session(
    db: &impl ConnectionTrait,
    id: i64,
    session: AgentSessionId,
) -> Result<(), StoreError> {
    let command = record::<AgentCommand>(
        db,
        "SELECT record_json FROM agent_commands WHERE id = ?",
        vec![id.into()],
    )
    .await?
    .ok_or(StoreError::InvalidAgent("linked command does not exist"))?;
    if command.session_id != Some(session) {
        return Err(StoreError::InvalidAgent(
            "linked command belongs to another session",
        ));
    }
    Ok(())
}

pub(super) async fn input_turns(
    db: &impl ConnectionTrait,
    input: &AgentInput,
) -> Result<(), StoreError> {
    for id in [input.requested_turn_id, input.turn_id]
        .into_iter()
        .flatten()
    {
        let turn = record::<AgentTurn>(
            db,
            "SELECT record_json FROM agent_turns WHERE id = ?",
            vec![id.as_i64().into()],
        )
        .await?
        .ok_or(StoreError::InvalidAgent("input references a missing turn"))?;
        same_session(input.session_id, turn.session_id)?;
    }
    Ok(())
}
