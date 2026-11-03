//! Typed mapping of the cp_turn_usage_minutes table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_turn_usage_minutes")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub team_id: i64,
    #[sea_orm(primary_key, auto_increment = false)]
    pub minute_at: i64,
    pub sent_bytes: Decimal,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
