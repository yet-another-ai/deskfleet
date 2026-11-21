//! Association between a hosted eve root session, its paying Team and its metering cursor.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_cloud_sessions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub session_id: String,
    pub team_id: i64,
    pub title: Option<String>,
    pub next_line: i64,
    pub last_active_at: i64,
    pub next_check_at: Option<i64>,
    pub meter_claim_until: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
