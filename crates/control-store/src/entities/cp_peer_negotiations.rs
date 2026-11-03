//! Typed mapping of the cp_peer_negotiations table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_peer_negotiations")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub peer_id: String,
    pub offer: Option<String>,
    pub options: Json,
    pub answer: Option<String>,
    pub pending: Json,
    pub started_at: Option<i64>,
    pub failed: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
