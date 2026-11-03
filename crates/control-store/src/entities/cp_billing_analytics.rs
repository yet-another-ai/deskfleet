//! Typed mapping of the cp_billing_analytics table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_billing_analytics")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub event_id: String,
    pub team_id: i64,
    pub event: Json,
    pub available_at: i64,
    pub attempts: i32,
    pub claim_token: Option<String>,
    pub claimed_until: Option<i64>,
    pub sent_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
