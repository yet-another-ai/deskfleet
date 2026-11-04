//! Typed mapping of the cp_catalogs table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_catalogs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub registration_id: i64,
    pub snapshot: Json,
    pub providers: Json,
    pub observed_at: i64,
    pub inventory_revision: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
