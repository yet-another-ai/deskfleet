//! Typed mapping of the cp_cloudflare_turn_sources table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_cloudflare_turn_sources")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub identifier: String,
    pub team_id: i64,
    pub account_id: String,
    pub key_id: String,
    pub analytics_token: String,
    pub expires_at: i64,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
