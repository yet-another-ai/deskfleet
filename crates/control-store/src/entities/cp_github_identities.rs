//! Typed mapping of the cp_github_identities table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_github_identities")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub subject: String,
    pub user_id: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
