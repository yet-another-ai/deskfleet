//! Typed mapping of the cp_cloudflare_turn_collector table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_cloudflare_turn_collector")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub singleton: bool,
    pub owner: Option<String>,
    pub lease_until: Option<i64>,
    pub last_seen_at: Option<i64>,
    pub gap_since: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
