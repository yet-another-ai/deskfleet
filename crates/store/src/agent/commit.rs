use deskfleet_model::agent::*;
use sea_orm::{
    ConnectionTrait, EntityTrait, Set, TransactionTrait,
    sea_query::{Expr, ExprTrait, OnConflict, Query},
};

use super::{queries::generation, scoped_session, validation};
use crate::{
    LocalCatalog, StoreError,
    entities::{
        agent_command, agent_command_revision, agent_elicitation, agent_event, agent_input,
        agent_permission, agent_run, agent_session, agent_turn, workspace_session,
    },
};

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
            || !changes.elicitations.is_empty()
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
                    // A stopped Session may switch Agents; ownership and the
                    // execution context remain immutable.
                    if next.provider != current.provider && next.provider_session_id.is_some() {
                        return Err(StoreError::InvalidAgent(
                            "switching the Agent requires a new provider session",
                        ));
                    }
                    if next.id != current.id
                        || next.workspace_id != current.workspace_id
                        || next.context != current.context
                        || next.created_at != current.created_at
                        || next.inherited_turn_count != current.inherited_turn_count
                    {
                        return Err(StoreError::InvalidAgent(
                            "session ownership and context are immutable",
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
                agent_run::Entity::insert(agent_run::ActiveModel {
                    session_id: Set(id.as_i64()),
                    generation: Set(generation(run.generation)?),
                    state: Set(run.state.as_str().to_owned()),
                    record_json: Set(serde_json::to_string(run)?),
                })
                .on_conflict(
                    OnConflict::columns([
                        agent_run::Column::SessionId,
                        agent_run::Column::Generation,
                    ])
                    .update_columns([agent_run::Column::State, agent_run::Column::RecordJson])
                    .to_owned(),
                )
                .exec_without_returning(&db)
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
                agent_input::Entity::insert(agent_input::ActiveModel {
                    id: Set(input.id.as_i64()),
                    session_id: Set(id.as_i64()),
                    state: Set(input.state.as_str().to_owned()),
                    submission_command_id: Set(input.submission_command_id.as_i64()),
                    accepted_seq: Set(input.accepted_seq.as_i64()),
                    dispatch_command_id: Set(input.dispatch_command_id.map(|value| value.as_i64())),
                    record_json: Set(serde_json::to_string(input)?),
                })
                .on_conflict(
                    OnConflict::columns([agent_input::Column::Id])
                        .update_columns([
                            agent_input::Column::SessionId,
                            agent_input::Column::State,
                            agent_input::Column::SubmissionCommandId,
                            agent_input::Column::AcceptedSeq,
                            agent_input::Column::DispatchCommandId,
                            agent_input::Column::RecordJson,
                        ])
                        .to_owned(),
                )
                .exec_without_returning(&db)
                .await?;
            }
            for turn in &changes.turns {
                validation::same_session(id, turn.session_id)?;
                validation::turn(&db, turn).await?;
                agent_turn::Entity::insert(agent_turn::ActiveModel {
                    id: Set(turn.id.as_i64()),
                    session_id: Set(id.as_i64()),
                    state: Set(turn.state.as_str().to_owned()),
                    initial_input_id: Set(turn.initial_input_id.as_i64()),
                    initial_dispatch_command_id: Set(turn.dispatch_command_id.as_i64()),
                    run_generation: Set(generation(turn.run_generation)?),
                    record_json: Set(serde_json::to_string(turn)?),
                })
                .on_conflict(
                    OnConflict::columns([agent_turn::Column::Id])
                        .update_columns([
                            agent_turn::Column::SessionId,
                            agent_turn::Column::State,
                            agent_turn::Column::InitialInputId,
                            agent_turn::Column::InitialDispatchCommandId,
                            agent_turn::Column::RunGeneration,
                            agent_turn::Column::RecordJson,
                        ])
                        .to_owned(),
                )
                .exec_without_returning(&db)
                .await?;
            }
            for input in &changes.inputs {
                validation::input_turns(&db, input).await?;
            }
            for permission in &changes.permissions {
                validation::same_session(id, permission.session_id)?;
                validation::permission(&db, permission).await?;
                agent_permission::Entity::insert(agent_permission::ActiveModel {
                    id: Set(permission.id.as_i64()),
                    session_id: Set(id.as_i64()),
                    state: Set(permission.state.as_str().to_owned()),
                    run_generation: Set(generation(permission.run_generation)?),
                    turn_id: Set(permission.turn_id.map(|value| value.as_i64())),
                    decision_command_id: Set(permission
                        .decision_command_id
                        .map(|value| value.as_i64())),
                    record_json: Set(serde_json::to_string(permission)?),
                })
                .on_conflict(
                    OnConflict::columns([agent_permission::Column::Id])
                        .update_columns([
                            agent_permission::Column::SessionId,
                            agent_permission::Column::State,
                            agent_permission::Column::RunGeneration,
                            agent_permission::Column::TurnId,
                            agent_permission::Column::DecisionCommandId,
                            agent_permission::Column::RecordJson,
                        ])
                        .to_owned(),
                )
                .exec_without_returning(&db)
                .await?;
            }
            for elicitation in &changes.elicitations {
                validation::same_session(id, elicitation.session_id)?;
                validation::elicitation(&db, elicitation).await?;
                agent_elicitation::Entity::insert(agent_elicitation::ActiveModel {
                    id: Set(elicitation.id.as_i64()),
                    session_id: Set(id.as_i64()),
                    state: Set(elicitation.state.as_str().to_owned()),
                    run_generation: Set(generation(elicitation.run_generation)?),
                    turn_id: Set(elicitation.turn_id.map(|value| value.as_i64())),
                    decision_command_id: Set(elicitation
                        .decision_command_id
                        .map(|value| value.as_i64())),
                    record_json: Set(serde_json::to_string(elicitation)?),
                })
                .on_conflict(
                    OnConflict::columns([agent_elicitation::Column::Id])
                        .update_columns([
                            agent_elicitation::Column::SessionId,
                            agent_elicitation::Column::State,
                            agent_elicitation::Column::RunGeneration,
                            agent_elicitation::Column::TurnId,
                            agent_elicitation::Column::DecisionCommandId,
                            agent_elicitation::Column::RecordJson,
                        ])
                        .to_owned(),
                )
                .exec_without_returning(&db)
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
                agent_event::Entity::insert(agent_event::ActiveModel {
                    session_id: Set(id.as_i64()),
                    seq: Set(seq),
                    run_generation: Set(event.event.run_generation.map(generation).transpose()?),
                    turn_id: Set(event.event.turn_id.map(|value| value.as_i64())),
                    input_id: Set(event.event.input_id.map(|value| value.as_i64())),
                    command_id: Set(event.event.command_id.map(|value| value.as_i64())),
                    record_json: Set(serde_json::to_string(&event)?),
                })
                .exec_without_returning(&db)
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
    agent_session::Entity::insert(agent_session::ActiveModel {
        session_id: Set(session.id.as_i64()),
        lifecycle: Set(session.lifecycle.as_str().to_owned()),
        archive_state: Set(session.archive_state.as_str().to_owned()),
        last_event_seq: Set(session.last_event_seq.as_i64()),
        record_json: Set(serde_json::to_string(session)?),
    })
    .on_conflict(
        OnConflict::columns([agent_session::Column::SessionId])
            .update_columns([
                agent_session::Column::Lifecycle,
                agent_session::Column::ArchiveState,
                agent_session::Column::LastEventSeq,
                agent_session::Column::RecordJson,
            ])
            .to_owned(),
    )
    .exec_without_returning(db)
    .await?;
    Ok(())
}

pub(super) async fn save_command(
    db: &impl ConnectionTrait,
    command: &AgentCommand,
) -> Result<(), StoreError> {
    validation::command(db, command).await?;
    // A deleted or rejected target remains in immutable audit JSON. The live
    // resource FK is nullable so deleting a Session cannot erase its audit.
    let session_id = if let Some(id) = command.session_id {
        workspace_session::Entity::find_by_id(id.as_i64())
            .one(db)
            .await?
            .map(|_| id.as_i64())
    } else {
        None
    };
    // Receipt changes need their own cursor: creation and rejected commands
    // can be persisted without advancing a Session's event sequence.
    let revision: i64 = db
        .query_one(
            &Query::update()
                .table(agent_command_revision::Entity)
                .value(
                    agent_command_revision::Column::LastRevision,
                    Expr::col(agent_command_revision::Column::LastRevision).add(1),
                )
                .and_where(Expr::col(agent_command_revision::Column::Id).eq(1))
                .and_where(Expr::col(agent_command_revision::Column::LastRevision).lt(i64::MAX))
                .returning_col(agent_command_revision::Column::LastRevision)
                .to_owned(),
        )
        .await?
        .ok_or(StoreError::InvalidAgent(
            "command revision allocator exhausted",
        ))?
        .try_get("", "last_revision")?;
    agent_command::Entity::insert(agent_command::ActiveModel {
        id: Set(command.id.as_i64()),
        operation_id: Set(command.operation_id.clone()),
        is_canonical: Set(command.is_canonical),
        state: Set(command.status.as_str().to_owned()),
        session_id: Set(session_id),
        revision: Set(revision),
        conflicting_command_id: Set(command.conflicting_command_id.map(|value| value.as_i64())),
        record_json: Set(serde_json::to_string(command)?),
    })
    .on_conflict(
        OnConflict::columns([agent_command::Column::Id])
            .update_columns([
                agent_command::Column::OperationId,
                agent_command::Column::IsCanonical,
                agent_command::Column::State,
                agent_command::Column::SessionId,
                agent_command::Column::Revision,
                agent_command::Column::ConflictingCommandId,
                agent_command::Column::RecordJson,
            ])
            .to_owned(),
    )
    .exec_without_returning(db)
    .await?;
    Ok(())
}
