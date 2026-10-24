use deskfleet_model::agent::*;
use sea_orm::{ConnectionTrait, TransactionTrait};

use super::{
    scoped_session,
    sql::{generation, statement, upsert},
    validation,
};
use crate::{LocalCatalog, StoreError};

impl LocalCatalog {
    /// Compare the journal watermark and commit state, audit, and events together.
    /// The caller serializes orchestration, while the database enforces claims.
    pub async fn agent_commit(
        &self,
        changes: AgentCommit,
    ) -> Result<AgentCommitResult, StoreError> {
        let db = self.catalog.database().begin().await?;
        let has_domain = changes.session.is_some()
            || !changes.runs.is_empty()
            || !changes.inputs.is_empty()
            || !changes.turns.is_empty()
            || !changes.permissions.is_empty()
            || !changes.events.is_empty();
        if has_domain && changes.events.is_empty() {
            return Err(StoreError::InvalidAgent(
                "domain changes require a journal event",
            ));
        }
        let mut session = match changes.session_id {
            Some(id) => {
                let current = scoped_session(&db, self.machine.id.as_i64(), id)
                    .await?
                    .ok_or(StoreError::NotFound {
                        kind: "agent session",
                        id: id.as_i64(),
                    })?;
                let expected = changes.expected_seq.ok_or(StoreError::InvalidAgent(
                    "session commits require an expected sequence",
                ))?;
                if current.last_event_seq != expected {
                    return Err(StoreError::AgentConflict {
                        expected: expected.as_i64(),
                        actual: current.last_event_seq.as_i64(),
                    });
                }
                if let Some(next) = changes.session {
                    if next.id != current.id
                        || next.workspace_id != current.workspace_id
                        || next.provider != current.provider
                        || next.context != current.context
                        || next.created_at != current.created_at
                    {
                        return Err(StoreError::InvalidAgent(
                            "session ownership, provider, and context are immutable",
                        ));
                    }
                    Some(AgentSessionRecord {
                        last_event_seq: current.last_event_seq,
                        ..next
                    })
                } else {
                    Some(current)
                }
            }
            None if has_domain || changes.expected_seq.is_some() => {
                return Err(StoreError::InvalidAgent("domain changes require a session"));
            }
            None => None,
        };
        if let Some(command) = &changes.command {
            if let Some(session) = &session
                && command.session_id != Some(session.id)
            {
                return Err(StoreError::InvalidAgent(
                    "command belongs to another session",
                ));
            }
            save_command(&db, command).await?;
        }
        let mut events = Vec::with_capacity(changes.events.len());
        if let Some(current) = &mut session {
            let id = current.id;
            let count = i64::try_from(changes.events.len())
                .map_err(|_| StoreError::InvalidAgent("too many events"))?;
            let final_seq = current
                .last_event_seq
                .as_i64()
                .checked_add(count)
                .ok_or(StoreError::InvalidAgent("journal sequence exhausted"))?;
            for run in &changes.runs {
                validation::same_session(id, run.session_id)?;
                validation::run(&db, run).await?;
                upsert(
                    &db,
                    "agent_runs",
                    &["session_id", "generation"],
                    &[
                        ("session_id", id.as_i64().into()),
                        ("generation", generation(run.generation)?.into()),
                        ("state", run.state.as_str().into()),
                    ],
                    run,
                )
                .await?;
            }
            for input in &changes.inputs {
                validation::same_session(id, input.session_id)?;
                validation::input(&db, input).await?;
                if input.accepted_seq.as_i64() > final_seq {
                    return Err(StoreError::InvalidAgent(
                        "input acceptance exceeds the journal",
                    ));
                }
                upsert(
                    &db,
                    "agent_inputs",
                    &["id"],
                    &[
                        ("id", input.id.as_i64().into()),
                        ("session_id", id.as_i64().into()),
                        ("state", input.state.as_str().into()),
                        (
                            "submission_command_id",
                            input.submission_command_id.as_i64().into(),
                        ),
                        ("accepted_seq", input.accepted_seq.as_i64().into()),
                        (
                            "dispatch_command_id",
                            input.dispatch_command_id.map(|value| value.as_i64()).into(),
                        ),
                    ],
                    input,
                )
                .await?;
            }
            for turn in &changes.turns {
                validation::same_session(id, turn.session_id)?;
                validation::turn(&db, turn).await?;
                upsert(
                    &db,
                    "agent_turns",
                    &["id"],
                    &[
                        ("id", turn.id.as_i64().into()),
                        ("session_id", id.as_i64().into()),
                        ("state", turn.state.as_str().into()),
                        ("initial_input_id", turn.initial_input_id.as_i64().into()),
                        (
                            "initial_dispatch_command_id",
                            turn.dispatch_command_id.as_i64().into(),
                        ),
                        ("run_generation", generation(turn.run_generation)?.into()),
                    ],
                    turn,
                )
                .await?;
            }
            for input in &changes.inputs {
                validation::input_turns(&db, input).await?;
            }
            for permission in &changes.permissions {
                validation::same_session(id, permission.session_id)?;
                validation::permission(&db, permission).await?;
                upsert(
                    &db,
                    "agent_permissions",
                    &["id"],
                    &[
                        ("id", permission.id.as_i64().into()),
                        ("session_id", id.as_i64().into()),
                        ("state", permission.state.as_str().into()),
                        (
                            "run_generation",
                            generation(permission.run_generation)?.into(),
                        ),
                        (
                            "turn_id",
                            permission.turn_id.map(|value| value.as_i64()).into(),
                        ),
                        (
                            "decision_command_id",
                            permission
                                .decision_command_id
                                .map(|value| value.as_i64())
                                .into(),
                        ),
                    ],
                    permission,
                )
                .await?;
            }
            let mut seq = current.last_event_seq.as_i64();
            current.last_event_seq = final_seq.into();
            for mut draft in changes.events {
                validation::same_session(id, draft.session_id)?;
                if let Some(command_id) = draft.command_id {
                    validation::command_session(&db, command_id.as_i64(), id).await?;
                }
                seq += 1; // checked as a whole before writing any records
                if draft.kind == EventKind::Session {
                    draft.payload = serde_json::to_value(&*current)?;
                }
                let event = AgentEvent {
                    seq: seq.into(),
                    event: draft,
                };
                let json = serde_json::to_string(&event)?;
                db.execute_raw(statement(
                    "INSERT INTO agent_events \
                     (session_id, seq, run_generation, turn_id, input_id, command_id, record_json) \
                     VALUES (?, ?, ?, ?, ?, ?, ?)",
                    vec![
                        id.as_i64().into(),
                        seq.into(),
                        event
                            .event
                            .run_generation
                            .map(generation)
                            .transpose()?
                            .into(),
                        event.event.turn_id.map(|value| value.as_i64()).into(),
                        event.event.input_id.map(|value| value.as_i64()).into(),
                        event.event.command_id.map(|value| value.as_i64()).into(),
                        json.into(),
                    ],
                ))
                .await?;
                events.push(event);
            }
            save_session(&db, current).await?;
        }
        db.commit().await?;
        Ok(AgentCommitResult { events, session })
    }
}

pub(super) async fn save_session(
    db: &impl ConnectionTrait,
    session: &AgentSessionRecord,
) -> Result<(), StoreError> {
    upsert(
        db,
        "agent_sessions",
        &["session_id"],
        &[
            ("session_id", session.id.as_i64().into()),
            ("lifecycle", session.lifecycle.as_str().into()),
            ("last_event_seq", session.last_event_seq.as_i64().into()),
        ],
        session,
    )
    .await
}

pub(super) async fn save_command(
    db: &impl ConnectionTrait,
    command: &AgentCommand,
) -> Result<(), StoreError> {
    validation::command(db, command).await?;
    // A deleted or rejected target remains in immutable audit JSON. The live
    // resource FK is nullable so deleting a Session cannot erase its audit.
    let session_id = if let Some(id) = command.session_id {
        db.query_one_raw(statement(
            "SELECT id FROM workspace_sessions WHERE id = ?",
            vec![id.as_i64().into()],
        ))
        .await?
        .map(|_| id.as_i64())
    } else {
        None
    };
    upsert(
        db,
        "agent_commands",
        &["id"],
        &[
            ("id", command.id.as_i64().into()),
            ("operation_id", command.operation_id.clone().into()),
            ("is_canonical", command.is_canonical.into()),
            ("state", command.status.as_str().into()),
            ("session_id", session_id.into()),
            (
                "conflicting_command_id",
                command
                    .conflicting_command_id
                    .map(|value| value.as_i64())
                    .into(),
            ),
        ],
        command,
    )
    .await
}
