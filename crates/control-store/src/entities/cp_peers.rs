//! Typed mapping of the cp_peers table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_peers")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub registration_id: i64,
    pub team_id: i64,
    pub user_id: String,
    pub login_session_id: String,
    pub grant_json: Json,
    pub expires_at: i64,
    pub revoked: bool,
    pub relay_allowed: bool,
    pub ice_servers: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
