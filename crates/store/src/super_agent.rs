use crate::{LocalCatalog, StoreError, entities::super_agent_state as state};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set, sea_query::Expr};

impl LocalCatalog {
    pub async fn super_agent_states(&self) -> Result<Vec<state::Model>, StoreError> {
        Ok(state::Entity::find().all(self.catalog.database()).await?)
    }

    /// Compare-and-swap an entire user's front desk and dispatch ledger before effects.
    pub async fn save_super_agent_state(
        &self,
        user_id: String,
        revision: i32,
        state_json: String,
    ) -> Result<(), StoreError> {
        let db = self.catalog.database();
        let next = revision
            .checked_add(1)
            .ok_or(StoreError::InvalidAgent("front desk revision overflow"))?;
        if revision == 0 {
            state::ActiveModel {
                user_id: Set(user_id),
                revision: Set(next),
                state_json: Set(state_json),
            }
            .insert(db)
            .await?;
        } else {
            let changed = state::Entity::update_many()
                .col_expr(state::Column::StateJson, Expr::value(state_json))
                .col_expr(state::Column::Revision, Expr::value(next))
                .filter(state::Column::UserId.eq(user_id))
                .filter(state::Column::Revision.eq(revision))
                .exec(db)
                .await?;
            if changed.rows_affected != 1 {
                return Err(StoreError::InvalidAgent("front desk changed during write"));
            }
        }
        Ok(())
    }
}
