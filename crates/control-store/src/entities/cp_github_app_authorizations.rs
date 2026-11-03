//! Typed mapping of the cp_github_app_authorizations table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_github_app_authorizations")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub user_id: String,
    pub client_id: String,
    pub subject: String,
    pub login: String,
    pub access_token: String,
    pub expires_at: Option<i64>,
    pub refresh_token: Option<String>,
    pub refresh_expires_at: Option<i64>,
    pub act_as_you: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
