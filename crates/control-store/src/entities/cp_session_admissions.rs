//! Typed mapping of the cp_session_admissions table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_session_admissions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub team_id: i64,
    pub registration_id: i64,
    pub kind: String,
    pub requested_session_id: Option<String>,
    pub session_id: Option<String>,
    pub status: String,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
