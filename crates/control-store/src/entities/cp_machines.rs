//! Typed mapping of the cp_machines table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_machines")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub identity_token_hash: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
