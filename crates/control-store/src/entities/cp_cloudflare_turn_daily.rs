//! Provider UTC-day snapshots, independent of Team billing-period boundaries.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_cloudflare_turn_daily")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub identifier: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub day_start: i64,
    pub egress_bytes: i64,
    pub query_end: i64,
    pub collected_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
