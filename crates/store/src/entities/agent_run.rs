use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "agent_runs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub session_id: i64,
    #[sea_orm(primary_key, auto_increment = false)]
    pub generation: i64,
    pub state: String,
    pub record_json: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
