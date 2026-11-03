//! Typed mapping of the cp_realtime_messages table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_realtime_messages")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub node_id: String,
    pub payload: Json,
    pub expires_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
