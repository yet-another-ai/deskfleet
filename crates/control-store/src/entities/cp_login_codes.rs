//! Typed mapping of the cp_login_codes table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_login_codes")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub code_hash: String,
    pub user_id: String,
    pub verifier_hash: String,
    pub credential_version: i64,
    pub expires_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
