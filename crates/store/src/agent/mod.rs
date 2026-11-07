//! Durable Agent Session records and an atomically sequenced journal.

mod commit;
mod queries;
mod validation;

#[cfg(test)]
mod tests;

use deskfleet_model::{AgentSequence, AgentSessionId, agent::*};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, QueryTrait, Set, TransactionTrait,
    sea_query::{Expr, ExprTrait, JoinType, OnConflict, Query, SelectStatement},
};

use crate::{
    LocalCatalog, StoreError,
    catalog::require_workspace,
    entities::{
        agent_command, agent_event, agent_id_allocator, agent_run, agent_session, catalog_identity,
        workspace_session,
    },
};
use queries::{record, records};

pub(crate) async fn initialize(db: &impl ConnectionTrait) -> Result<(), StoreError> {
    catalog_identity::Entity::insert(catalog_identity::ActiveModel {
        id: Set(1),
        origin_id: Set(uuid::Uuid::new_v4().to_string()),
    })
    .on_conflict(
        OnConflict::column(catalog_identity::Column::Id)
            .do_nothing()
            .to_owned(),
    )
    .exec_without_returning(db)
    .await?;
    agent_id_allocator::Entity::insert(agent_id_allocator::ActiveModel {
        id: Set(1),
        last_id: Set(0),
    })
    .on_conflict(
        OnConflict::column(agent_id_allocator::Column::Id)
            .do_nothing()
            .to_owned(),
    )
    .exec_without_returning(db)
    .await?;
    Ok(())
}

impl LocalCatalog {
    pub async fn agent_identity(&self) -> Result<AgentIdentity, StoreError> {
        let row = catalog_identity::Entity::find_by_id(1)
            .one(self.catalog.database())
            .await?
            .ok_or(StoreError::InvalidAgent("catalog identity is missing"))?;
        Ok(AgentIdentity {
            origin_id: row.origin_id,
            machine_id: self.machine.id,
        })
    }

    /// Allocate durable identities independently of process lifetime and deletions.
    pub async fn agent_allocate_id(&self) -> Result<i64, StoreError> {
        let row = self
            .catalog
            .database()
            .query_one(
                &Query::update()
                    .table(agent_id_allocator::Entity)
                    .value(
                        agent_id_allocator::Column::LastId,
                        Expr::col(agent_id_allocator::Column::LastId).add(1),
                    )
                    .and_where(Expr::col(agent_id_allocator::Column::Id).eq(1))
                    .and_where(Expr::col(agent_id_allocator::Column::LastId).lt(i64::MAX))
                    .returning_col(agent_id_allocator::Column::LastId)
                    .to_owned(),
            )
            .await?
            .ok_or(StoreError::InvalidAgent("agent ID allocator exhausted"))?;
        Ok(row.try_get("", "last_id")?)
    }

    pub async fn agent_list(&self) -> Result<Vec<AgentSessionRecord>, StoreError> {
        records(
            self.catalog.database(),
            scoped_sessions(self.machine.id.as_i64())
                .order_by(agent_session::Column::SessionId, sea_orm::Order::Asc)
                .to_owned(),
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
                agent_run::Entity::find()
                    .select_only()
                    .column(agent_run::Column::RecordJson)
                    .filter(agent_run::Column::SessionId.eq(id.as_i64()))
                    .order_by_asc(agent_run::Column::Generation)
                    .into_query(),
            )
            .await?,
            inputs: records(&db, queries::inputs(id.as_i64())).await?,
            turns: records(&db, queries::turns(id.as_i64())).await?,
            permissions: records(&db, queries::permissions(id.as_i64())).await?,
            elicitations: records(&db, queries::elicitations(id.as_i64())).await?,
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
            agent_event::Entity::find()
                .select_only()
                .column(agent_event::Column::RecordJson)
                .filter(agent_event::Column::SessionId.eq(id.as_i64()))
                .filter(agent_event::Column::Seq.gt(after.as_i64()))
                .order_by_asc(agent_event::Column::Seq)
                .limit(u64::from(limit))
                .into_query(),
        )
        .await?;
        db.commit().await?;
        Ok(events)
    }

    pub async fn agent_command(
        &self,
        operation_id: &str,
    ) -> Result<Option<AgentCommand>, StoreError> {
        record(self.catalog.database(), queries::command(operation_id)).await
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
            agent_session::Entity::find_by_id(id.as_i64())
                .select_only()
                .column(agent_session::Column::RecordJson)
                .into_query(),
        )
        .await?;
        if existing.is_some() {
            return Ok(false);
        }
        let deleted: bool = db
            .query_one(&queries::deleted_admission(id.as_i64()))
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
        let commands = records(&db, queries::commands(id.as_i64())).await?;
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
            .query_one(
                &agent_command::Entity::find()
                    .select_only()
                    .column_as(agent_command::Column::Revision.max(), "revision")
                    .filter(agent_command::Column::SessionId.eq(id.as_i64()))
                    .into_query(),
            )
            .await?
            .and_then(|row| row.try_get::<Option<i64>>("", "revision").transpose())
            .transpose()?
            .unwrap_or(after_revision);
        let revision = std::cmp::max(revision, after_revision);
        let commands = records(&db, queries::command_changes(id.as_i64(), after_revision)).await?;
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
            agent_command::Entity::find_by_id(request.command.id.as_i64())
                .select_only()
                .column(agent_command::Column::RecordJson)
                .into_query(),
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
            turn_limit_code: None,
            last_event_seq: 0.into(),
            last_completed_seq: None,
            last_read_seq: None,
            configuration_since_seq: None,
            viewers: Vec::new(),
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
        scoped_sessions(machine_id)
            .and_where(
                Expr::col((agent_session::Entity, agent_session::Column::SessionId))
                    .eq(id.as_i64()),
            )
            .to_owned(),
    )
    .await
}

fn scoped_sessions(machine_id: i64) -> SelectStatement {
    Query::select()
        .column((agent_session::Entity, agent_session::Column::RecordJson))
        .from(agent_session::Entity)
        .join(
            JoinType::InnerJoin,
            workspace_session::Entity,
            Expr::col((workspace_session::Entity, workspace_session::Column::Id)).eq(Expr::col((
                agent_session::Entity,
                agent_session::Column::SessionId,
            ))),
        )
        .and_where(
            Expr::col((
                workspace_session::Entity,
                workspace_session::Column::MachineId,
            ))
            .eq(machine_id),
        )
        .to_owned()
}
