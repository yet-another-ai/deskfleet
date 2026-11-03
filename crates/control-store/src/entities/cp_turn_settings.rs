//! Typed mapping of the cp_turn_settings table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_turn_settings")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub singleton: bool,
    pub urls: Json,
    pub allow_team_servers: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
