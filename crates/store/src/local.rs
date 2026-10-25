//! A standalone daemon's durable, machine-scoped catalog.

use std::path::Path;

use deskfleet_migration::{Migrator, MigratorTrait};
use deskfleet_model::{
    AgentSessionId, DirectoryBindings, Machine, MachineId, TeamId, WorkspaceId, WorkspaceSession,
    Worktree,
};
use sea_orm::{
    ActiveModelTrait, ConnectOptions, Database, DatabaseConnection, EntityTrait, IntoActiveModel,
    QueryOrder, Set, TransactionTrait,
};

use crate::{
    Catalog, CatalogWorkspace, StoreError,
    entities::{machine, team},
};

/// A coherent view of the standalone daemon's catalog.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalSnapshot {
    pub team_id: TeamId,
    pub machine_id: MachineId,
    pub machine_name: String,
    pub workspaces: Vec<CatalogWorkspace>,
}

/// Catalog access bound to the machine in a dedicated daemon database.
///
/// Its local team is a standalone ownership context, not account membership.
/// The daemon must own its discovery endpoint before opening this database.
pub struct LocalCatalog {
    pub(crate) catalog: Catalog,
    pub(crate) machine: Machine,
}

impl LocalCatalog {
    /// Open a SQLite file, migrate it, and persist the local ownership context.
    ///
    /// The filename is passed through SQLite options rather than URL syntax.
    /// The parent directory must already exist.
    pub async fn open(path: impl AsRef<Path>, machine_name: &str) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        let mut options = ConnectOptions::new("sqlite:");
        options.max_connections(1).sqlx_logging(false);
        options.map_sqlx_sqlite_opts(move |options| {
            options
                .filename(&path)
                .create_if_missing(true)
                .foreign_keys(true)
        });
        let database = Database::connect(options).await?;
        Self::initialize(database, machine_name).await
    }

    /// Create an isolated in-memory SQLite catalog with the local ownership context.
    ///
    /// The single connection stays open until the catalog is closed or dropped.
    ///
    /// # Errors
    /// Returns an error if connecting, migrating, or initializing the catalog fails.
    pub async fn open_in_memory(machine_name: &str) -> Result<Self, StoreError> {
        let mut options = ConnectOptions::new("sqlite::memory:");
        options
            .max_connections(1)
            .min_connections(1)
            .idle_timeout(None)
            .max_lifetime(None)
            .sqlx_logging(false);
        options.map_sqlx_sqlite_opts(|options| options.foreign_keys(true));
        let database = Database::connect(options).await?;
        Self::initialize(database, machine_name).await
    }

    async fn initialize(
        database: DatabaseConnection,
        machine_name: &str,
    ) -> Result<Self, StoreError> {
        Migrator::up(&database, None).await?;
        let transaction = database.begin().await?;
        let row = match machine::Entity::find()
            .order_by_asc(machine::Column::Id)
            .one(&transaction)
            .await?
        {
            Some(row) => {
                let mut row = row.into_active_model();
                row.name = Set(machine_name.to_owned());
                row.update(&transaction).await?
            }
            None => {
                let team = team::ActiveModel {
                    name: Set("Local".to_owned()),
                    ..Default::default()
                }
                .insert(&transaction)
                .await?;
                machine::ActiveModel {
                    team_id: Set(team.id),
                    name: Set(machine_name.to_owned()),
                    ..Default::default()
                }
                .insert(&transaction)
                .await?
            }
        };
        crate::agent::initialize(&transaction).await?;
        transaction.commit().await?;
        Ok(Self {
            catalog: Catalog::new(database),
            machine: Machine {
                id: row.id.into(),
                team_id: row.team_id.into(),
                name: row.name,
            },
        })
    }

    pub async fn snapshot(&self) -> Result<LocalSnapshot, StoreError> {
        Ok(LocalSnapshot {
            team_id: self.machine.team_id,
            machine_id: self.machine.id,
            machine_name: self.machine.name.clone(),
            workspaces: self.catalog.workspaces(self.machine.id).await?,
        })
    }

    pub async fn create_workspace(
        &self,
        name: &str,
        directories: DirectoryBindings,
    ) -> Result<CatalogWorkspace, StoreError> {
        self.catalog
            .create_workspace(self.machine.id, name, directories)
            .await
    }

    pub async fn update_workspace(
        &self,
        id: WorkspaceId,
        name: &str,
        directories: DirectoryBindings,
    ) -> Result<CatalogWorkspace, StoreError> {
        self.catalog
            .update_workspace(self.machine.id, id, name, directories)
            .await
    }

    pub async fn delete_workspace(&self, id: WorkspaceId) -> Result<(), StoreError> {
        self.catalog.delete_workspace(self.machine.id, id).await
    }

    pub async fn create_workspace_session(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<WorkspaceSession, StoreError> {
        self.catalog
            .create_workspace_session(self.machine.id, workspace_id)
            .await
    }

    pub async fn attach_session_worktree(
        &self,
        session_id: AgentSessionId,
        directories: DirectoryBindings,
    ) -> Result<Worktree, StoreError> {
        self.catalog
            .attach_session_worktree(self.machine.id, session_id, directories)
            .await
    }

    pub async fn delete_workspace_session(
        &self,
        session_id: AgentSessionId,
    ) -> Result<(), StoreError> {
        self.catalog
            .delete_workspace_session(self.machine.id, session_id)
            .await
    }

    /// Close the pool when the daemon shuts down.
    pub async fn close(&self) -> Result<(), StoreError> {
        self.catalog.database().close_by_ref().await?;
        Ok(())
    }
}
