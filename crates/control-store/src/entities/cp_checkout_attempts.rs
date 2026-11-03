//! Typed mapping of the cp_checkout_attempts table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_checkout_attempts")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub request_id: String,
    pub team_id: i64,
    pub plan: String,
    pub billing_interval: String,
    pub session_id: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub actor_user_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
