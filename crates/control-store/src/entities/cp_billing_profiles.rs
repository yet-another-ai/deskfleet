//! Typed mapping of the cp_billing_profiles table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_billing_profiles")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub team_id: i64,
    pub customer_id: Option<String>,
    pub subscription_id: Option<String>,
    pub plan: Option<String>,
    pub subscription_status: Option<String>,
    pub paid_through: Option<i64>,
    pub period_anchor: i64,
    pub cancel_at_period_end: bool,
    pub enterprise: bool,
    pub grant_plan: Option<String>,
    pub grant_expires_at: Option<i64>,
    pub reconciled_at: Option<i64>,
    pub lease_token: Option<String>,
    pub lease_until: Option<i64>,
    pub reconcile_after: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
