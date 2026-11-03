//! Typed mapping of the cp_search_entries table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_search_entries")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub registration_id: i64,
    #[sea_orm(primary_key, auto_increment = false)]
    pub session_id: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub entry_key: String,
    pub entry_id: String,
    pub tail: String,
    pub next_block: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
