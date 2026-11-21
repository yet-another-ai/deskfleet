//! Deployment-wide credit cost per model token, with cache reads and writes priced separately.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_cloud_credit_rates")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub singleton: bool,
    pub input: BigDecimal,
    pub output: BigDecimal,
    pub cache_read: BigDecimal,
    pub cache_write: BigDecimal,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
