//! Machine-backed BYOA Super Agent sessions indexed for unified Team history and MCP consent.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_super_agent_machine_sessions")]
pub struct Model {
    pub team_id: i64,
    #[sea_orm(primary_key, auto_increment = false)]
    pub registration_id: i64,
    #[sea_orm(primary_key, auto_increment = false)]
    pub session_id: String,
    pub provider_id: String,
    pub provider_name: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub title: Option<String>,
    pub last_active_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
