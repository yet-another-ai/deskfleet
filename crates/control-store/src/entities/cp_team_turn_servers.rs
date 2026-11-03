//! Typed mapping of the cp_team_turn_servers table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_team_turn_servers")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub team_id: i64,
    pub urls: Json,
    pub secret: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
