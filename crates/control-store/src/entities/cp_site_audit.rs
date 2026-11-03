//! Typed mapping of the cp_site_audit table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_site_audit")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub actor_user_id: Option<String>,
    pub source: String,
    pub action: String,
    pub target_user_id: Option<String>,
    pub before_value: Json,
    pub after_value: Json,
    pub occurred_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
