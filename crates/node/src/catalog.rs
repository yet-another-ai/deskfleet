//! Thin asynchronous catalog binding owned by the machine daemon.

use deskfleet_model::{DirectoryBinding, DirectoryBindings, WorkspaceSession, Worktree};
use deskfleet_store::{CatalogWorkspace as StoredWorkspace, LocalCatalog, LocalSnapshot};
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
    pub async fn agent_commands(&self, session_id: String) -> Result<String> {
        json(
            self.catalog
                .agent_commands(parse_id(session_id)?)
                .await
                .map_err(native_error)?,
        )
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
