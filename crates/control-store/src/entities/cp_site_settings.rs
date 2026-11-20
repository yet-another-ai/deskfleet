//! Typed mapping of the cp_site_settings table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_site_settings")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub singleton: bool,
    pub site_name: String,
    pub announcement: String,
    pub allow_team_creation: bool,
    pub terms_of_service_url: String,
    pub privacy_terms_url: String,
    pub telemetry_enabled: bool,
    pub captcha_enabled: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
