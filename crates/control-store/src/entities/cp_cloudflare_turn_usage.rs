//! Typed mapping of the cp_cloudflare_turn_usage table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_cloudflare_turn_usage")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub identifier: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub period_start: i64,
    #[sea_orm(primary_key, auto_increment = false)]
    pub period_end: i64,
    pub expires_at: i64,
    pub egress_bytes: i64,
    pub query_end: Option<i64>,
    pub collected_at: Option<i64>,
    pub last_attempt_at: Option<i64>,
    pub daily_collected_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
