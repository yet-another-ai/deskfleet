use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_cloud_agent_requests")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub team_id: i64,
    pub fingerprint: String,
    pub session_id: Option<String>,
    pub position: i64,
    pub prewarm_claim_until: Option<i64>,
    pub result_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
