//! Worktree records and their machine-local directory bindings.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "worktrees")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub workspace_id: Option<i64>,
    pub session_id: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::workspace::Entity",
        from = "Column::WorkspaceId",
        to = "super::workspace::Column::Id",
        on_delete = "Cascade"
    )]
    Workspace,
    #[sea_orm(
        belongs_to = "super::workspace_session::Entity",
        from = "Column::SessionId",
        to = "super::workspace_session::Column::Id",
        on_delete = "Cascade"
    )]
    WorkspaceSession,
    #[sea_orm(has_many = "super::worktree_directory::Entity")]
    WorktreeDirectory,
}

impl Related<super::workspace::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Workspace.def()
    }
}

impl Related<super::worktree_directory::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::WorktreeDirectory.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

impl Related<super::workspace_session::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::WorkspaceSession.def()
    }
}
