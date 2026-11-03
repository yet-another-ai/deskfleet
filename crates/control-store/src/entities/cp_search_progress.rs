//! Typed mapping of the cp_search_progress table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_search_progress")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub registration_id: i64,
    #[sea_orm(primary_key, auto_increment = false)]
    pub session_id: String,
    pub indexed_seq: i64,
    pub stable_seq: i64,
    pub snapshot_idle_seq: i64,
    pub previous_key: Option<String>,
    pub previous_turn: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
