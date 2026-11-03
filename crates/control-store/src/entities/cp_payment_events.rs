//! Typed mapping of the cp_payment_events table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_payment_events")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub event_type: String,
    pub object_id: String,
    pub status: String,
    pub attempts: i32,
    pub available_at: i64,
    pub claim_token: Option<String>,
    pub claimed_until: Option<i64>,
    pub error_code: Option<String>,
    pub received_at: i64,
    pub occurred_at: Option<i64>,
    pub payment_attempt: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
