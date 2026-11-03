//! Typed mapping of the cp_auth_limits table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_auth_limits")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub key_hash: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub period: i64,
    pub requests: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
