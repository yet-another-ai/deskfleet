//! Typed mapping of the cp_machine_registrations table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_machine_registrations")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub team_id: i64,
    pub owner_id: String,
    pub name: String,
    pub origin_id: String,
    pub local_machine_id: String,
    pub token_hash: String,
    pub capabilities: Json,
    pub last_seen_at: Option<i64>,
    pub revoked: bool,
    pub machine_id: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
