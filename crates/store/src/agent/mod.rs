//! Durable Agent Session records and an atomically sequenced journal.

mod commit;
mod sql;
mod validation;

#[cfg(test)]
mod tests;

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

    /// Read only the Session metadata and journal watermark.
    pub async fn agent_session(
        &self,
        id: AgentSessionId,
    ) -> Result<Option<AgentSessionRecord>, StoreError> {
        scoped_session(self.catalog.database(), self.machine.id.as_i64(), id).await
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
            inputs: records(&db, sql::INPUTS, vec![id.as_i64().into()]).await?,
            turns: records(&db, sql::TURNS, vec![id.as_i64().into()]).await?,
            permissions: records(&db, sql::PERMISSIONS, vec![id.as_i64().into()]).await?,
            elicitations: records(&db, sql::ELICITATIONS, vec![id.as_i64().into()]).await?,
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
            sql::COMMAND,
            vec![operation_id.into()],
        )
        .await
    }

    /// Prove a released local allocation from retained receipts, even after its row is gone.
    pub async fn agent_admission_deleted(&self, operation_id: &str) -> Result<bool, StoreError> {
        let Some(admission) = self.agent_command(operation_id).await? else {
            return Ok(false);
        };
        if !matches!(
            admission.method.as_str(),
            "_deskfleet/session/create" | "_deskfleet/session/fork" | "_deskfleet/session/restore"
        ) {
            return Ok(false);
        }
        let Some(id) = admission.session_id else {
            return Ok(false);
        };
        let db = self.catalog.database().begin().await?;
        let existing: Option<AgentSessionRecord> = record(
            &db,
            "SELECT record_json FROM agent_sessions WHERE session_id = ?",
            vec![id.as_i64().into()],
        )
        .await?;
        if existing.is_some() {
            return Ok(false);
        }
        let deleted: bool = db
            .query_one_raw(statement(
                sql::DELETED_ADMISSION,
                vec![id.to_string().into()],
            ))
            .await?
            .ok_or(StoreError::InvalidAgent(
                "deletion receipt query returned no result",
            ))?
            .try_get("", "deleted")?;
        db.commit().await?;
        Ok(deleted)
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
        let commands = records(&db, sql::COMMANDS, vec![id.as_i64().into()]).await?;
        db.commit().await?;
        Ok(commands)
    }

    /// Current receipts changed after a durable revision; -1 includes migrated receipts.
    pub async fn agent_commands_since(
        &self,
        id: AgentSessionId,
        after_revision: i64,
    ) -> Result<(Vec<AgentCommand>, i64), StoreError> {
        if after_revision < -1 {
            return Err(StoreError::InvalidAgent("invalid command revision"));
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
        let revision = db
            .query_one_raw(statement(
                "SELECT MAX(revision) AS revision FROM agent_commands WHERE session_id = ?",
                vec![id.as_i64().into()],
            ))
            .await?
            .and_then(|row| row.try_get::<Option<i64>>("", "revision").transpose())
            .transpose()?
            .unwrap_or(after_revision)
            .max(after_revision);
        let commands = records(
            &db,
            sql::COMMAND_CHANGES,
            vec![id.as_i64().into(), after_revision.into()],
        )
        .await?;
        db.commit().await?;
        Ok((commands, revision))
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
            title_customized: false,
            context: request.context,
            lifecycle: SessionLifecycle::Provisioning,
            archive_state: ArchiveState::Active,
            inherited_turn_count: request.inherited_turn_count,
            admission_generation: request.admission_generation,
            turn_limit_reason: None,
            last_event_seq: 0.into(),
            last_completed_seq: None,
            last_read_seq: None,
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
