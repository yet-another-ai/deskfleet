//! Deployment-wide entitlements for each billing plan.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_plan_limits")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub plan: String,
    pub max_active_sessions: Option<i64>,
    pub max_turns_per_session: Option<i64>,
    pub max_members: Option<i64>,
    pub turn_bytes: Option<i64>,
    pub super_agent_tokens: Option<i64>,
    pub team_turn_servers: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
