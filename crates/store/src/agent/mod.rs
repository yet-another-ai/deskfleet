//! Durable Agent Session records and an atomically sequenced journal.

mod commit;
mod sql;
mod validation;

use deskfleet_model::{AgentSequence, AgentSessionId, agent::*};
use sea_orm::{ActiveModelTrait, ConnectionTrait, Set, TransactionTrait};

use crate::{LocalCatalog, StoreError, catalog::require_workspace, entities::workspace_session};
use sql::{record, records, statement};

pub(crate) async fn initialize(db: &impl ConnectionTrait) -> Result<(), StoreError> {
    db.execute_raw(statement(
        "INSERT INTO catalog_identity (id, origin_id) VALUES (1, ?) ON CONFLICT (id) DO NOTHING",
        vec![uuid::Uuid::new_v4().to_string().into()],
    ))
    .await?;
    db.execute_raw(statement(
        "INSERT INTO agent_id_allocator (id, last_id) VALUES (1, 0) ON CONFLICT (id) DO NOTHING",
        vec![],
    ))
    .await?;
    Ok(())
}

impl LocalCatalog {
    pub async fn agent_identity(&self) -> Result<AgentIdentity, StoreError> {
        let row = self
            .catalog
            .database()
            .query_one_raw(statement(
                "SELECT origin_id FROM catalog_identity WHERE id = 1",
                vec![],
            ))
            .await?
            .ok_or(StoreError::InvalidAgent("catalog identity is missing"))?;
        Ok(AgentIdentity {
            origin_id: row.try_get("", "origin_id")?,
            machine_id: self.machine.id,
        })
    }

    /// Allocate durable identities independently of process lifetime and deletions.
    pub async fn agent_allocate_id(&self) -> Result<i64, StoreError> {
        let row = self
            .catalog
            .database()
            .query_one_raw(statement(
                "UPDATE agent_id_allocator SET last_id = last_id + 1 \
                 WHERE id = 1 AND last_id < 9223372036854775807 RETURNING last_id",
                vec![],
            ))
            .await?
            .ok_or(StoreError::InvalidAgent("agent ID allocator exhausted"))?;
        Ok(row.try_get("", "last_id")?)
    }

    pub async fn agent_list(&self) -> Result<Vec<AgentSessionRecord>, StoreError> {
        records(
            self.catalog.database(),
            "SELECT a.record_json FROM agent_sessions a \
             JOIN workspace_sessions s ON s.id = a.session_id \
             WHERE s.machine_id = ? ORDER BY a.session_id",
            vec![self.machine.id.as_i64().into()],
        )
        .await
    }

    pub async fn agent_snapshot(
        &self,
        id: AgentSessionId,
    ) -> Result<Option<AgentSnapshot>, StoreError> {
        let db = self.catalog.database().begin().await?;
        let Some(session) = scoped_session(&db, self.machine.id.as_i64(), id).await? else {
            return Ok(None);
        };
        let snapshot = AgentSnapshot {
            session,
            runs: records(
                &db,
                "SELECT record_json FROM agent_runs WHERE session_id = ? ORDER BY generation",
                vec![id.as_i64().into()],
            )
            .await?,
            inputs: records(
                &db,
                "SELECT record_json FROM agent_inputs WHERE session_id = ? ORDER BY accepted_seq, id",
                vec![id.as_i64().into()],
            )
            .await?,
            turns: records(
                &db,
                "SELECT record_json FROM agent_turns WHERE session_id = ? ORDER BY id",
                vec![id.as_i64().into()],
            )
            .await?,
            permissions: records(
                &db,
                "SELECT record_json FROM agent_permissions WHERE session_id = ? ORDER BY id",
                vec![id.as_i64().into()],
            )
            .await?,
            elicitations: records(
                &db,
                "SELECT record_json FROM agent_elicitations WHERE session_id = ? ORDER BY id",
                vec![id.as_i64().into()],
            )
            .await?,
        };
        db.commit().await?;
        Ok(Some(snapshot))
    }

    pub async fn agent_history(
        &self,
        id: AgentSessionId,
        after: AgentSequence,
        limit: u32,
    ) -> Result<Vec<AgentEvent>, StoreError> {
        if after.as_i64() < 0 || !(1..=1000).contains(&limit) {
            return Err(StoreError::InvalidAgent("invalid journal cursor or limit"));
        }
        let db = self.catalog.database().begin().await?;
        if scoped_session(&db, self.machine.id.as_i64(), id)
            .await?
            .is_none()
        {
            return Err(StoreError::NotFound {
                kind: "agent session",
                id: id.as_i64(),
            });
        }
        let events = records(
            &db,
            "SELECT record_json FROM agent_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            vec![id.as_i64().into(), after.as_i64().into(), limit.into()],
        )
        .await?;
        db.commit().await?;
        Ok(events)
    }

    pub async fn agent_command(
        &self,
        operation_id: &str,
    ) -> Result<Option<AgentCommand>, StoreError> {
        record(
            self.catalog.database(),
            "SELECT record_json FROM agent_commands WHERE operation_id = ? AND is_canonical = 1",
            vec![operation_id.into()],
        )
        .await
    }

    /// Current audit receipts for one Session, including failed and rejected requests.
    pub async fn agent_commands(
        &self,
        id: AgentSessionId,
    ) -> Result<Vec<AgentCommand>, StoreError> {
        let db = self.catalog.database().begin().await?;
        if scoped_session(&db, self.machine.id.as_i64(), id)
            .await?
            .is_none()
        {
            return Err(StoreError::NotFound {
                kind: "agent session",
                id: id.as_i64(),
            });
        }
        let commands = records(
            &db,
            "SELECT record_json FROM agent_commands WHERE session_id = ? ORDER BY id",
            vec![id.as_i64().into()],
        )
        .await?;
        db.commit().await?;
        Ok(commands)
    }

    /// Bind the accepted create command to its catalog Session in one transaction.
    /// Provisioning the Git worktree follows only after this transaction succeeds.
    pub async fn agent_create_session(
        &self,
        request: AgentCreateSession,
    ) -> Result<AgentCreatedSession, StoreError> {
        let db = self.catalog.database().begin().await?;
        if let Some(workspace_id) = request.workspace_id {
            require_workspace(&db, self.machine.id, workspace_id).await?;
        }
        if !request.command.is_canonical
            || request.command.status != CommandStatus::Accepted
            || request.command.session_id.is_some()
        {
            return Err(StoreError::InvalidAgent(
                "creation requires an accepted canonical command without a session",
            ));
        }
        if record::<AgentCommand>(
            &db,
            "SELECT record_json FROM agent_commands WHERE id = ?",
            vec![request.command.id.as_i64().into()],
        )
        .await?
        .is_some()
        {
            return Err(StoreError::InvalidAgent(
                "create command was already recorded",
            ));
        }
        let row = workspace_session::ActiveModel {
            machine_id: Set(self.machine.id.as_i64()),
            workspace_id: Set(request.workspace_id.map(|id| id.as_i64())),
            ..Default::default()
        }
        .insert(&db)
        .await?;
        let session = AgentSessionRecord {
            id: row.id.into(),
            workspace_id: request.workspace_id,
            provider: request.provider,
            provider_session_id: None,
            title: request.title,
            context: request.context,
            lifecycle: SessionLifecycle::Provisioning,
            archive_state: ArchiveState::Active,
            last_event_seq: 0.into(),
            created_at: request.command.received_at.clone(),
            updated_at: request.command.received_at.clone(),
            capabilities: None,
            error: None,
        };
        let mut command = request.command;
        command.session_id = Some(session.id);
        command.workspace_id = session.workspace_id;
        command.result = Some(serde_json::json!({"sessionId": session.id}));
        commit::save_command(&db, &command).await?;
        commit::save_session(&db, &session).await?;
        db.commit().await?;
        Ok(AgentCreatedSession { command, session })
    }
}

async fn scoped_session(
    db: &impl ConnectionTrait,
    machine_id: i64,
    id: AgentSessionId,
) -> Result<Option<AgentSessionRecord>, StoreError> {
    record(
        db,
        "SELECT a.record_json FROM agent_sessions a \
         JOIN workspace_sessions s ON s.id = a.session_id \
         WHERE a.session_id = ? AND s.machine_id = ?",
        vec![id.as_i64().into(), machine_id.into()],
    )
    .await
}
