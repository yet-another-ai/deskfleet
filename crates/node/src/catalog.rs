//! Thin asynchronous catalog binding owned by the machine daemon.

use deskfleet_model::{DirectoryBinding, DirectoryBindings, WorkspaceSession, Worktree};
use deskfleet_store::{
    CatalogWorkspace as StoredWorkspace, FollowUpActionWrite, FollowUpRunQuery, FollowUpRunWrite,
    FollowUpSourceWrite, LocalCatalog, LocalSnapshot,
};
use napi::Result;
use napi_derive::napi;

use crate::rtc::native_error;

#[napi(object)]
pub struct CatalogDirectory {
    pub path: String,
}

#[napi(object)]
pub struct CatalogWorktree {
    pub id: String,
    pub workspace_id: Option<String>,
    pub session_id: Option<String>,
    pub directories: Vec<CatalogDirectory>,
}

#[napi(object)]
pub struct CatalogWorkspace {
    pub id: String,
    pub name: String,
    pub worktrees: Vec<CatalogWorktree>,
}

#[napi(object)]
pub struct CatalogWorkspaceSession {
    pub id: String,
    pub machine_id: String,
    pub workspace_id: Option<String>,
}

#[napi(object)]
pub struct CatalogSnapshot {
    pub team_id: String,
    pub machine_id: String,
    pub machine_name: String,
    pub workspaces: Vec<CatalogWorkspace>,
    pub sessions: Vec<CatalogWorktree>,
}

impl From<Worktree> for CatalogWorktree {
    fn from(worktree: Worktree) -> Self {
        Self {
            id: worktree.id.to_string(),
            workspace_id: worktree.workspace_id.map(|id| id.to_string()),
            session_id: worktree.session_id.map(|id| id.to_string()),
            directories: Vec::<DirectoryBinding>::from(worktree.directories)
                .into_iter()
                .map(|directory| CatalogDirectory {
                    path: directory.path,
                })
                .collect(),
        }
    }
}

impl From<StoredWorkspace> for CatalogWorkspace {
    fn from(workspace: StoredWorkspace) -> Self {
        Self {
            id: workspace.workspace.id.to_string(),
            name: workspace.workspace.name,
            worktrees: workspace.worktrees.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<WorkspaceSession> for CatalogWorkspaceSession {
    fn from(session: WorkspaceSession) -> Self {
        Self {
            id: session.id.to_string(),
            machine_id: session.machine_id.to_string(),
            workspace_id: session.workspace_id.map(|id| id.to_string()),
        }
    }
}

impl From<LocalSnapshot> for CatalogSnapshot {
    fn from(snapshot: LocalSnapshot) -> Self {
        Self {
            team_id: snapshot.team_id.to_string(),
            machine_id: snapshot.machine_id.to_string(),
            machine_name: snapshot.machine_name,
            workspaces: snapshot.workspaces.into_iter().map(Into::into).collect(),
            sessions: snapshot.sessions.into_iter().map(Into::into).collect(),
        }
    }
}

#[napi(object)]
pub struct SuperAgentStateRecord {
    pub user_id: String,
    pub revision: i32,
    pub state_json: String,
}

#[napi(object)]
pub struct SuperAgentFollowUpAuthRecord {
    pub user_id: String,
    pub revision: i32,
    pub auth_version: i32,
    pub state_json: String,
}

#[napi(object)]
pub struct SuperAgentFollowUpSourceRecord {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub source_kind: String,
    pub source_id: String,
    pub revision: i32,
    pub state_json: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct SuperAgentFollowUpRunRecord {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub source_kind: String,
    pub source_id: String,
    pub run_key: String,
    pub created_at: String,
    pub updated_at: String,
    pub record_json: String,
}

#[napi(object)]
pub struct SuperAgentFollowUpActionRecord {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub source_kind: String,
    pub source_id: String,
    pub action_key: String,
    pub status: String,
    pub auth_version: i32,
    pub created_at: String,
    pub updated_at: String,
    pub record_json: String,
}

#[napi]
pub struct NativeCatalog {
    catalog: LocalCatalog,
}

#[napi]
pub async fn open_catalog(database_path: String, machine_name: String) -> Result<NativeCatalog> {
    let catalog = LocalCatalog::open(database_path, &machine_name)
        .await
        .map_err(native_error)?;
    Ok(NativeCatalog { catalog })
}

#[napi]
pub async fn open_in_memory_catalog(machine_name: String) -> Result<NativeCatalog> {
    let catalog = LocalCatalog::open_in_memory(&machine_name)
        .await
        .map_err(native_error)?;
    Ok(NativeCatalog { catalog })
}

#[napi]
impl NativeCatalog {
    #[napi]
    pub async fn super_agent_states(&self) -> Result<Vec<SuperAgentStateRecord>> {
        Ok(self
            .catalog
            .super_agent_states()
            .await
            .map_err(native_error)?
            .into_iter()
            .map(|row| SuperAgentStateRecord {
                user_id: row.user_id,
                revision: row.revision,
                state_json: row.state_json,
            })
            .collect())
    }

    #[napi]
    pub async fn save_super_agent_state(
        &self,
        user_id: String,
        revision: i32,
        state_json: String,
    ) -> Result<()> {
        self.catalog
            .save_super_agent_state(user_id, revision, state_json)
            .await
            .map_err(native_error)
    }

    #[napi]
    pub async fn super_agent_follow_up_auths(&self) -> Result<Vec<SuperAgentFollowUpAuthRecord>> {
        Ok(self
            .catalog
            .super_agent_follow_up_auths()
            .await
            .map_err(native_error)?
            .into_iter()
            .map(|row| SuperAgentFollowUpAuthRecord {
                user_id: row.user_id,
                revision: row.revision,
                auth_version: row.auth_version,
                state_json: row.state_json,
            })
            .collect())
    }

    #[napi]
    pub async fn save_super_agent_follow_up_auth(
        &self,
        user_id: String,
        revision: i32,
        auth_version: i32,
        state_json: String,
    ) -> Result<()> {
        self.catalog
            .save_super_agent_follow_up_auth(user_id, revision, auth_version, state_json)
            .await
            .map_err(native_error)
    }

    #[napi]
    pub async fn super_agent_follow_up_sources(
        &self,
        user_id: Option<String>,
        workspace_id: Option<String>,
    ) -> Result<Vec<SuperAgentFollowUpSourceRecord>> {
        Ok(self
            .catalog
            .super_agent_follow_up_sources(user_id, workspace_id)
            .await
            .map_err(native_error)?
            .into_iter()
            .map(|row| SuperAgentFollowUpSourceRecord {
                id: row.id,
                user_id: row.user_id,
                workspace_id: row.workspace_id,
                source_kind: row.source_kind,
                source_id: row.source_id,
                revision: row.revision,
                state_json: row.state_json,
                updated_at: row.updated_at,
            })
            .collect())
    }

    #[napi]
    pub async fn save_super_agent_follow_up_source(
        &self,
        record: SuperAgentFollowUpSourceRecord,
    ) -> Result<SuperAgentFollowUpSourceRecord> {
        let saved = self
            .catalog
            .save_super_agent_follow_up_source(FollowUpSourceWrite {
                id: record.id,
                user_id: record.user_id,
                workspace_id: record.workspace_id,
                source_kind: record.source_kind,
                source_id: record.source_id,
                revision: record.revision,
                state_json: record.state_json,
                updated_at: record.updated_at,
            })
            .await
            .map_err(native_error)?;
        Ok(SuperAgentFollowUpSourceRecord {
            id: saved.id,
            user_id: saved.user_id,
            workspace_id: saved.workspace_id,
            source_kind: saved.source_kind,
            source_id: saved.source_id,
            revision: saved.revision,
            state_json: saved.state_json,
            updated_at: saved.updated_at,
        })
    }

    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub async fn super_agent_follow_up_runs(
        &self,
        user_id: String,
        workspace_id: Option<String>,
        source_kind: Option<String>,
        source_id: Option<String>,
        before_created_at: Option<String>,
        before_id: Option<String>,
        limit: u32,
    ) -> Result<Vec<SuperAgentFollowUpRunRecord>> {
        Ok(self
            .catalog
            .super_agent_follow_up_runs(FollowUpRunQuery {
                user_id,
                workspace_id,
                source_kind,
                source_id,
                before_created_at,
                before_id,
                limit,
            })
            .await
            .map_err(native_error)?
            .into_iter()
            .map(|row| SuperAgentFollowUpRunRecord {
                id: row.id,
                user_id: row.user_id,
                workspace_id: row.workspace_id,
                source_kind: row.source_kind,
                source_id: row.source_id,
                run_key: row.run_key,
                created_at: row.created_at,
                updated_at: row.updated_at,
                record_json: row.record_json,
            })
            .collect())
    }

    #[napi]
    pub async fn super_agent_follow_up_run(
        &self,
        user_id: String,
        workspace_id: String,
        source_kind: String,
        source_id: String,
        run_key: String,
    ) -> Result<Option<SuperAgentFollowUpRunRecord>> {
        Ok(self
            .catalog
            .super_agent_follow_up_run(user_id, workspace_id, source_kind, source_id, run_key)
            .await
            .map_err(native_error)?
            .map(|row| SuperAgentFollowUpRunRecord {
                id: row.id,
                user_id: row.user_id,
                workspace_id: row.workspace_id,
                source_kind: row.source_kind,
                source_id: row.source_id,
                run_key: row.run_key,
                created_at: row.created_at,
                updated_at: row.updated_at,
                record_json: row.record_json,
            }))
    }

    #[napi]
    pub async fn upsert_super_agent_follow_up_run(
        &self,
        record: SuperAgentFollowUpRunRecord,
    ) -> Result<SuperAgentFollowUpRunRecord> {
        let saved = self
            .catalog
            .upsert_super_agent_follow_up_run(FollowUpRunWrite {
                id: record.id,
                user_id: record.user_id,
                workspace_id: record.workspace_id,
                source_kind: record.source_kind,
                source_id: record.source_id,
                run_key: record.run_key,
                created_at: record.created_at,
                updated_at: record.updated_at,
                record_json: record.record_json,
            })
            .await
            .map_err(native_error)?;
        Ok(SuperAgentFollowUpRunRecord {
            id: saved.id,
            user_id: saved.user_id,
            workspace_id: saved.workspace_id,
            source_kind: saved.source_kind,
            source_id: saved.source_id,
            run_key: saved.run_key,
            created_at: saved.created_at,
            updated_at: saved.updated_at,
            record_json: saved.record_json,
        })
    }

    #[napi]
    pub async fn super_agent_follow_up_actions(
        &self,
        user_id: String,
        status: Option<String>,
        limit: u32,
        before_created_at: Option<String>,
        before_id: Option<String>,
    ) -> Result<Vec<SuperAgentFollowUpActionRecord>> {
        Ok(self
            .catalog
            .super_agent_follow_up_actions(user_id, status, limit, before_created_at, before_id)
            .await
            .map_err(native_error)?
            .into_iter()
            .map(|row| SuperAgentFollowUpActionRecord {
                id: row.id,
                user_id: row.user_id,
                workspace_id: row.workspace_id,
                source_kind: row.source_kind,
                source_id: row.source_id,
                action_key: row.action_key,
                status: row.status,
                auth_version: row.auth_version,
                created_at: row.created_at,
                updated_at: row.updated_at,
                record_json: row.record_json,
            })
            .collect())
    }

    #[napi]
    pub async fn upsert_super_agent_follow_up_action(
        &self,
        record: SuperAgentFollowUpActionRecord,
    ) -> Result<SuperAgentFollowUpActionRecord> {
        let saved = self
            .catalog
            .upsert_super_agent_follow_up_action(FollowUpActionWrite {
                id: record.id,
                user_id: record.user_id,
                workspace_id: record.workspace_id,
                source_kind: record.source_kind,
                source_id: record.source_id,
                action_key: record.action_key,
                status: record.status,
                auth_version: record.auth_version,
                created_at: record.created_at,
                updated_at: record.updated_at,
                record_json: record.record_json,
            })
            .await
            .map_err(native_error)?;
        Ok(SuperAgentFollowUpActionRecord {
            id: saved.id,
            user_id: saved.user_id,
            workspace_id: saved.workspace_id,
            source_kind: saved.source_kind,
            source_id: saved.source_id,
            action_key: saved.action_key,
            status: saved.status,
            auth_version: saved.auth_version,
            created_at: saved.created_at,
            updated_at: saved.updated_at,
            record_json: saved.record_json,
        })
    }

    #[napi]
    pub async fn snapshot(&self) -> Result<CatalogSnapshot> {
        self.catalog
            .snapshot()
            .await
            .map(Into::into)
            .map_err(native_error)
    }

    #[napi]
    pub async fn create_workspace(
        &self,
        name: String,
        directories: Vec<CatalogDirectory>,
    ) -> Result<CatalogWorkspace> {
        self.catalog
            .create_workspace(&name, directory_bindings(directories)?)
            .await
            .map(Into::into)
            .map_err(native_error)
    }

    #[napi]
    pub async fn update_workspace(
        &self,
        workspace_id: String,
        name: String,
        directories: Vec<CatalogDirectory>,
    ) -> Result<CatalogWorkspace> {
        self.catalog
            .update_workspace(
                parse_id(workspace_id)?,
                &name,
                directory_bindings(directories)?,
            )
            .await
            .map(Into::into)
            .map_err(native_error)
    }

    #[napi]
    pub async fn delete_workspace(&self, workspace_id: String) -> Result<()> {
        self.catalog
            .delete_workspace(parse_id(workspace_id)?)
            .await
            .map_err(native_error)
    }

    #[napi]
    pub async fn create_workspace_session(
        &self,
        workspace_id: String,
    ) -> Result<CatalogWorkspaceSession> {
        self.catalog
            .create_workspace_session(parse_id(workspace_id)?)
            .await
            .map(Into::into)
            .map_err(native_error)
    }

    #[napi]
    pub async fn attach_session_worktree(
        &self,
        session_id: String,
        directories: Vec<CatalogDirectory>,
    ) -> Result<CatalogWorktree> {
        self.catalog
            .attach_session_worktree(parse_id(session_id)?, directory_bindings(directories)?)
            .await
            .map(Into::into)
            .map_err(native_error)
    }

    #[napi]
    pub async fn delete_workspace_session(&self, session_id: String) -> Result<()> {
        self.catalog
            .delete_workspace_session(parse_id(session_id)?)
            .await
            .map_err(native_error)
    }

    #[napi]
    pub async fn agent_identity(&self) -> Result<String> {
        json(self.catalog.agent_identity().await.map_err(native_error)?)
    }

    #[napi]
    pub async fn agent_allocate_id(&self) -> Result<String> {
        self.catalog
            .agent_allocate_id()
            .await
            .map(|id| id.to_string())
            .map_err(native_error)
    }

    #[napi]
    pub async fn agent_list(&self) -> Result<String> {
        json(self.catalog.agent_list().await.map_err(native_error)?)
    }

    #[napi]
    pub async fn agent_session(&self, session_id: String) -> Result<String> {
        json(
            self.catalog
                .agent_session(parse_id(session_id)?)
                .await
                .map_err(native_error)?,
        )
    }

    #[napi]
    pub async fn agent_snapshot(&self, session_id: String) -> Result<String> {
        json(
            self.catalog
                .agent_snapshot(parse_id(session_id)?)
                .await
                .map_err(native_error)?,
        )
    }

    #[napi]
    pub async fn agent_history(
        &self,
        session_id: String,
        after_seq: String,
        limit: u32,
    ) -> Result<String> {
        json(
            self.catalog
                .agent_history(parse_id(session_id)?, parse_id(after_seq)?, limit)
                .await
                .map_err(native_error)?,
        )
    }

    #[napi]
    pub async fn agent_command(&self, operation_id: String) -> Result<String> {
        json(
            self.catalog
                .agent_command(&operation_id)
                .await
                .map_err(native_error)?,
        )
    }

    #[napi]
    pub async fn agent_admission_deleted(&self, operation_id: String) -> Result<bool> {
        self.catalog
            .agent_admission_deleted(&operation_id)
            .await
            .map_err(native_error)
    }

    #[napi]
    pub async fn agent_commands(&self, session_id: String) -> Result<String> {
        json(
            self.catalog
                .agent_commands(parse_id(session_id)?)
                .await
                .map_err(native_error)?,
        )
    }

    #[napi]
    pub async fn agent_commands_since(
        &self,
        session_id: String,
        after_revision: String,
    ) -> Result<String> {
        let (commands, revision) = self
            .catalog
            .agent_commands_since(parse_id(session_id)?, parse_id::<i64>(after_revision)?)
            .await
            .map_err(native_error)?;
        json(serde_json::json!({ "commands": commands, "revision": revision.to_string() }))
    }

    #[napi]
    pub async fn agent_commit(&self, transaction: String) -> Result<String> {
        let transaction = serde_json::from_str(&transaction).map_err(native_error)?;
        json(
            self.catalog
                .agent_commit(transaction)
                .await
                .map_err(native_error)?,
        )
    }

    #[napi]
    pub async fn agent_create_session(&self, request: String) -> Result<String> {
        let request = serde_json::from_str(&request).map_err(native_error)?;
        json(
            self.catalog
                .agent_create_session(request)
                .await
                .map_err(native_error)?,
        )
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        self.catalog.close().await.map_err(native_error)
    }
}

fn parse_id<T: From<i64>>(id: String) -> Result<T> {
    id.parse::<i64>()
        .map(Into::into)
        .map_err(|_| native_error("invalid catalog resource ID"))
}

fn directory_bindings(directories: Vec<CatalogDirectory>) -> Result<DirectoryBindings> {
    DirectoryBindings::new(
        directories
            .into_iter()
            .map(|directory| DirectoryBinding {
                path: directory.path,
            })
            .collect(),
    )
    .map_err(native_error)
}

fn json(value: impl serde::Serialize) -> Result<String> {
    serde_json::to_string(&value).map_err(native_error)
}
