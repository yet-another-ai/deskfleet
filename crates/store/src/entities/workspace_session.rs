//! Session lifecycle records owned by a machine, optionally a workspace.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "workspace_sessions")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub machine_id: i64,
    pub workspace_id: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::machine::Entity",
        from = "Column::MachineId",
        to = "super::machine::Column::Id",
        on_delete = "Restrict"
    )]
    Machine,
    #[sea_orm(
        belongs_to = "super::workspace::Entity",
        from = "Column::WorkspaceId",
        to = "super::workspace::Column::Id",
        on_delete = "Restrict"
    )]
    Workspace,
    #[sea_orm(has_one = "super::worktree::Entity")]
    Worktree,
}

impl Related<super::machine::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Machine.def()
    }
}

impl Related<super::workspace::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Workspace.def()
    }
}

impl Related<super::worktree::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Worktree.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
