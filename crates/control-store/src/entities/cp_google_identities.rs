//! Typed mapping of the cp_google_identities table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_google_identities")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub subject: String,
    pub user_id: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
