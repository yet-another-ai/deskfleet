use crate::entities::cp_maintenance;
use crate::{ControlStore, Result};
use sea_orm::sea_query::{Alias, Expr, ExprTrait, Func};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};

impl ControlStore {
    /// Coalesce global maintenance across API replicas. The server bounds a pass
    /// to less than this lease and retries unfinished batches on the next pass.
    pub async fn claim_expiry_maintenance(&self) -> Result<bool> {
        let now = || Expr::from(Func::cust(Alias::new("statement_timestamp")));
        Ok(cp_maintenance::Entity::update_many()
            .col_expr(
                cp_maintenance::Column::NextRunAt,
                now().add(Expr::val("30 seconds").cast_as(Alias::new("interval"))),
            )
            .filter(cp_maintenance::Column::Name.eq("expiry"))
            .filter(Expr::col(cp_maintenance::Column::NextRunAt).lte(now()))
            .exec(&self.db)
            .await?
            .rows_affected
            == 1)
    }
}
