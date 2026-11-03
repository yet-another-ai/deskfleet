//! Typed mapping of the cp_commands table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_commands")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub registration_id: i64,
    #[sea_orm(primary_key, auto_increment = false)]
    pub command_id: String,
    pub record: Json,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
