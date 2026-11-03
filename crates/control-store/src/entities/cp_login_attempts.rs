//! Typed mapping of the cp_login_attempts table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_login_attempts")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub state_hash: String,
    pub record: Json,
    pub expires_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
