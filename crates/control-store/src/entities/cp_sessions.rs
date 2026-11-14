//! Typed mapping of the cp_sessions table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_sessions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub registration_id: i64,
    #[sea_orm(primary_key, auto_increment = false)]
    pub session_id: String,
    pub snapshot: Json,
    pub snapshot_seq: i64,
    pub event_seq: i64,
    pub observed_at: i64,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
    /// Database-generated projection; leave unset in inserts and updates.
    pub summary: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
