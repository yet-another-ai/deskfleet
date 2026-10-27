use deskfleet_model::{
    AgentSessionId, DirectoryBinding, DirectoryBindings, Machine, MachineId, Team, TeamId,
    Workspace, WorkspaceId, WorkspaceSession, Worktree,
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction,
    EntityTrait, IntoActiveModel, QueryFilter, QueryOrder, Select, Set, TransactionTrait,
};

use crate::{
    StoreError,
    entities::{machine, team, workspace, workspace_session, worktree, worktree_directory},
};

/// A workspace with its automatic main and session-owned worktrees.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatalogWorkspace {
    pub workspace: Workspace,
    pub worktrees: Vec<Worktree>,
}

/// Typed catalog operations. Worktree lifetime follows workspace/session lifetime.
#[derive(Clone)]
pub struct Catalog {
    database: DatabaseConnection,
}

impl Catalog {
    pub fn new(database: DatabaseConnection) -> Self {
        Self { database }
    }

    pub fn database(&self) -> &DatabaseConnection {
        &self.database
    }

    pub async fn create_team(&self, name: &str) -> Result<Team, StoreError> {
        let row = team::ActiveModel {
            name: Set(name.to_owned()),
            ..Default::default()
        }
        .insert(&self.database)
        .await?;
        Ok(Team {
            id: row.id.into(),
            name: row.name,
        })
    }

    pub async fn create_machine(&self, team_id: TeamId, name: &str) -> Result<Machine, StoreError> {
        let row = machine::ActiveModel {
            team_id: Set(team_id.as_i64()),
            name: Set(name.to_owned()),
            ..Default::default()
        }
        .insert(&self.database)
        .await?;
        Ok(Machine {
            id: row.id.into(),
            team_id: row.team_id.into(),
            name: row.name,
        })
    }

    /// Create the workspace, its unique main worktree, and configured directories atomically.
    pub async fn create_workspace(
        &self,
        machine_id: MachineId,
        name: &str,
        directories: DirectoryBindings,
    ) -> Result<CatalogWorkspace, StoreError> {
        let transaction = self.database.begin().await?;
        let row = workspace::ActiveModel {
            machine_id: Set(machine_id.as_i64()),
            name: Set(name.to_owned()),
            ..Default::default()
        }
        .insert(&transaction)
        .await?;
        let main = insert_worktree(&transaction, Some(row.id.into()), None, directories).await?;
        transaction.commit().await?;
        Ok(CatalogWorkspace {
            workspace: workspace_model(row),
            worktrees: vec![main],
        })
    }

    pub async fn workspace(&self, id: WorkspaceId) -> Result<Option<CatalogWorkspace>, StoreError> {
        let transaction = self.database.begin().await?;
        let result = load_workspaces(&transaction, workspace::Entity::find_by_id(id.as_i64()))
            .await?
            .pop();
        transaction.commit().await?;
        Ok(result)
    }

    /// Read all owned workspaces and their directory contexts from one snapshot.
    pub async fn workspaces(
        &self,
        machine_id: MachineId,
    ) -> Result<Vec<CatalogWorkspace>, StoreError> {
        let transaction = self.database.begin().await?;
        let result = load_workspaces(
            &transaction,
            workspace::Entity::find().filter(workspace::Column::MachineId.eq(machine_id.as_i64())),
        )
        .await?;
        transaction.commit().await?;
        Ok(result)
    }

    /// Edit configured directories on the main worktree; session copies remain unchanged.
    pub async fn update_workspace(
        &self,
        machine_id: MachineId,
        id: WorkspaceId,
        name: &str,
        directories: DirectoryBindings,
    ) -> Result<CatalogWorkspace, StoreError> {
        let transaction = self.database.begin().await?;
        let row = require_workspace(&transaction, machine_id, id).await?;
        let main = worktree::Entity::find()
            .filter(worktree::Column::WorkspaceId.eq(id.as_i64()))
            .filter(worktree::Column::SessionId.is_null())
            .one(&transaction)
            .await?
            .ok_or(StoreError::MissingMainWorktree {
                workspace_id: id.as_i64(),
            })?;
        let mut row = row.into_active_model();
        row.name = Set(name.to_owned());
        let row = row.update(&transaction).await?;
        worktree_directory::Entity::delete_many()
            .filter(worktree_directory::Column::WorktreeId.eq(main.id))
            .exec(&transaction)
            .await?;
        insert_directories(&transaction, main.id, &directories).await?;
        let worktrees = load_worktrees(
            &transaction,
            worktree::Entity::find().filter(worktree::Column::WorkspaceId.eq(id.as_i64())),
        )
        .await?;
        transaction.commit().await?;
        Ok(CatalogWorkspace {
            workspace: workspace_model(row),
            worktrees,
        })
    }

    /// Delete a workspace and its main directories only after all sessions end.
    pub async fn delete_workspace(
        &self,
        machine_id: MachineId,
        id: WorkspaceId,
    ) -> Result<(), StoreError> {
        let transaction = self.database.begin().await?;
        require_workspace(&transaction, machine_id, id).await?;
        if workspace_session::Entity::find()
            .filter(workspace_session::Column::WorkspaceId.eq(id.as_i64()))
            .one(&transaction)
            .await?
            .is_some()
        {
            return Err(StoreError::WorkspaceHasSessions {
                workspace_id: id.as_i64(),
            });
        }
        workspace::Entity::delete_by_id(id.as_i64())
            .exec(&transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Allocate a session before the daemon creates its managed Git directories.
    pub async fn create_workspace_session(
        &self,
        machine_id: MachineId,
        workspace_id: WorkspaceId,
    ) -> Result<WorkspaceSession, StoreError> {
        let transaction = self.database.begin().await?;
        require_workspace(&transaction, machine_id, workspace_id).await?;
        let row = workspace_session::ActiveModel {
            machine_id: Set(machine_id.as_i64()),
            workspace_id: Set(Some(workspace_id.as_i64())),
            ..Default::default()
        }
        .insert(&transaction)
        .await?;
        transaction.commit().await?;
        Ok(WorkspaceSession {
            id: row.id.into(),
            machine_id,
            workspace_id: Some(workspace_id),
        })
    }

    /// Allocate a machine-scoped session that is not owned by a Workspace.
    pub async fn create_machine_session(
        &self,
        machine_id: MachineId,
    ) -> Result<WorkspaceSession, StoreError> {
        let transaction = self.database.begin().await?;
        let row = workspace_session::ActiveModel {
            machine_id: Set(machine_id.as_i64()),
            workspace_id: Set(None),
            ..Default::default()
        }
        .insert(&transaction)
        .await?;
        transaction.commit().await?;
        Ok(WorkspaceSession {
            id: row.id.into(),
            machine_id,
            workspace_id: None,
        })
    }

    /// Record the managed directories for one session, at most once.
    pub async fn attach_session_worktree(
        &self,
        machine_id: MachineId,
        session_id: AgentSessionId,
        directories: DirectoryBindings,
    ) -> Result<Worktree, StoreError> {
        let transaction = self.database.begin().await?;
        let session = require_session(&transaction, machine_id, session_id).await?;
        let worktree = insert_worktree(
            &transaction,
            session.workspace_id.map(Into::into),
            Some(session_id),
            directories,
        )
        .await?;
        transaction.commit().await?;
        Ok(worktree)
    }

    /// Session-owned worktrees that are not nested under a Workspace.
    pub async fn machine_session_worktrees(
        &self,
        machine_id: MachineId,
    ) -> Result<Vec<Worktree>, StoreError> {
        let transaction = self.database.begin().await?;
        let sessions = workspace_session::Entity::find()
            .filter(workspace_session::Column::MachineId.eq(machine_id.as_i64()))
            .filter(workspace_session::Column::WorkspaceId.is_null())
            .all(&transaction)
            .await?;
        if sessions.is_empty() {
            transaction.commit().await?;
            return Ok(Vec::new());
        }
        let worktrees = load_worktrees(
            &transaction,
            worktree::Entity::find().filter(
                worktree::Column::SessionId.is_in(sessions.iter().map(|session| session.id)),
            ),
        )
        .await?;
        transaction.commit().await?;
        Ok(worktrees)
    }

    /// End a session; its owned worktree and directory rows cascade, preserving main.
    pub async fn delete_workspace_session(
        &self,
        machine_id: MachineId,
        session_id: AgentSessionId,
    ) -> Result<(), StoreError> {
        let transaction = self.database.begin().await?;
        require_session(&transaction, machine_id, session_id).await?;
        workspace_session::Entity::delete_by_id(session_id.as_i64())
            .exec(&transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }
}

pub(crate) async fn require_workspace(
    database: &impl ConnectionTrait,
    machine_id: MachineId,
    id: WorkspaceId,
) -> Result<workspace::Model, StoreError> {
    workspace::Entity::find_by_id(id.as_i64())
        .filter(workspace::Column::MachineId.eq(machine_id.as_i64()))
        .one(database)
        .await?
        .ok_or(StoreError::NotFound {
            kind: "workspace",
            id: id.as_i64(),
        })
}

pub(crate) async fn require_session(
    database: &impl ConnectionTrait,
    machine_id: MachineId,
    id: AgentSessionId,
) -> Result<workspace_session::Model, StoreError> {
    workspace_session::Entity::find_by_id(id.as_i64())
        .filter(workspace_session::Column::MachineId.eq(machine_id.as_i64()))
        .one(database)
        .await?
        .ok_or(StoreError::NotFound {
            kind: "session",
            id: id.as_i64(),
        })
}

async fn load_workspaces(
    database: &impl ConnectionTrait,
    query: Select<workspace::Entity>,
) -> Result<Vec<CatalogWorkspace>, StoreError> {
    let rows = query
        .order_by_asc(workspace::Column::Id)
        .all(database)
        .await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let worktrees = load_worktrees(
        database,
        worktree::Entity::find()
            .filter(worktree::Column::WorkspaceId.is_in(rows.iter().map(|row| row.id))),
    )
    .await?;
    let mut children = std::collections::BTreeMap::<i64, Vec<Worktree>>::new();
    for worktree in worktrees {
        let Some(workspace_id) = worktree.workspace_id else {
            continue;
        };
        children
            .entry(workspace_id.as_i64())
            .or_default()
            .push(worktree);
    }
    rows.into_iter()
        .map(|row| {
            let worktrees = children.remove(&row.id).unwrap_or_default();
            if worktrees
                .iter()
                .filter(|worktree| worktree.session_id.is_none())
                .count()
                != 1
            {
                return Err(StoreError::MissingMainWorktree {
                    workspace_id: row.id,
                });
            }
            Ok(CatalogWorkspace {
                workspace: workspace_model(row),
                worktrees,
            })
        })
        .collect()
}

async fn load_worktrees(
    database: &impl ConnectionTrait,
    query: Select<worktree::Entity>,
) -> Result<Vec<Worktree>, StoreError> {
    let rows = query
        .order_by_asc(worktree::Column::Id)
        .find_with_related(worktree_directory::Entity)
        .order_by_asc(worktree_directory::Column::Position)
        .all(database)
        .await?;
    rows.into_iter()
        .map(|(row, directories)| {
            Ok(Worktree {
                id: row.id.into(),
                workspace_id: row.workspace_id.map(Into::into),
                session_id: row.session_id.map(Into::into),
                directories: DirectoryBindings::new(
                    directories
                        .into_iter()
                        .map(|directory| DirectoryBinding {
                            path: directory.path,
                        })
                        .collect(),
                )?,
            })
        })
        .collect()
}

fn workspace_model(row: workspace::Model) -> Workspace {
    Workspace {
        id: row.id.into(),
        machine_id: row.machine_id.into(),
        name: row.name,
    }
}

async fn insert_worktree(
    transaction: &DatabaseTransaction,
    workspace_id: Option<WorkspaceId>,
    session_id: Option<AgentSessionId>,
    directories: DirectoryBindings,
) -> Result<Worktree, StoreError> {
    let row = worktree::ActiveModel {
        workspace_id: Set(workspace_id.map(|id| id.as_i64())),
        session_id: Set(session_id.map(|id| id.as_i64())),
        ..Default::default()
    }
    .insert(transaction)
    .await?;
    insert_directories(transaction, row.id, &directories).await?;
    Ok(Worktree {
        id: row.id.into(),
        workspace_id,
        session_id,
        directories,
    })
}

async fn insert_directories(
    transaction: &DatabaseTransaction,
    worktree_id: i64,
    bindings: &DirectoryBindings,
) -> Result<(), StoreError> {
    let rows = bindings
        .as_slice()
        .iter()
        .enumerate()
        .map(|(position, binding)| {
            Ok(worktree_directory::ActiveModel {
                worktree_id: Set(worktree_id),
                path: Set(binding.path.clone()),
                position: Set(i32::try_from(position).map_err(|_| StoreError::TooManyDirectories)?),
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    worktree_directory::Entity::insert_many(rows)
        .exec(transaction)
        .await?;
    Ok(())
}
