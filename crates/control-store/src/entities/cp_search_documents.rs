//! Typed mapping of the cp_search_documents table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_search_documents")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub registration_id: i64,
    #[sea_orm(primary_key, auto_increment = false)]
    pub kind: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub resource_id: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub entry_id: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub block_no: i64,
    pub priority: i16,
    pub content: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
