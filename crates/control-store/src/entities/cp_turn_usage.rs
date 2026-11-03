//! Typed mapping of the cp_turn_usage table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_turn_usage")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub peer_id: String,
    pub team_id: i64,
    pub realm: String,
    pub allocation_id: String,
    pub side: String,
    pub received_bytes: i64,
    pub sent_bytes: i64,
    pub collected_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
