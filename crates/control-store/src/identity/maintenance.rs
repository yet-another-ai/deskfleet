//! Bounded expiration of credentials that have no post-expiry consumers.
use crate::entities::{
    cp_auth_limits, cp_identity_challenges, cp_invites, cp_login_attempts, cp_login_codes, cp_peers,
};
use crate::{ControlStore, Result, now_ms};
use sea_orm::sea_query::{
    Alias, CommonTableExpression, Expr, ExprTrait, LockBehavior, LockType, Order, Query,
};
use sea_orm::{ConnectionTrait, EntityTrait};

impl ControlStore {
    /// Remove at most `limit` expired rows from each short-lived identity table.
    /// The server's shared maintenance lease coalesces passes across replicas.
    /// Locked ceremonies are skipped so maintenance cannot delay authentication.
    /// Peer grants retain a day after expiry for acknowledged cleanup.
    ///
    /// # Errors
    /// Returns an error when an expiration query fails.
    pub async fn prune_auth_records(&self, limit: i64) -> Result<u64> {
        let limit =
            u64::try_from(limit.clamp(1, 1_000)).expect("clamped expiration limit is positive");
        let now = now_ms();
        let mut removed = 0;
        removed += prune::<cp_auth_limits::Entity>(
            &self.db,
            cp_auth_limits::Column::Period,
            now - 3_600_000,
            limit,
        )
        .await?;
        removed += prune::<cp_login_attempts::Entity>(
            &self.db,
            cp_login_attempts::Column::ExpiresAt,
            now,
            limit,
        )
        .await?;
        removed += prune::<cp_login_codes::Entity>(
            &self.db,
            cp_login_codes::Column::ExpiresAt,
            now,
            limit,
        )
        .await?;
        removed += prune::<cp_identity_challenges::Entity>(
            &self.db,
            cp_identity_challenges::Column::ExpiresAt,
            now,
            limit,
        )
        .await?;
        removed += prune::<cp_invites::Entity>(&self.db, cp_invites::Column::ExpiresAt, now, limit)
            .await?;
        removed += prune::<cp_peers::Entity>(
            &self.db,
            cp_peers::Column::ExpiresAt,
            now - 86_400_000,
            limit,
        )
        .await?;
        Ok(removed)
    }
}

async fn prune<E: EntityTrait>(
    db: &impl ConnectionTrait,
    expiry: E::Column,
    cutoff: i64,
    limit: u64,
) -> Result<u64> {
    // PostgreSQL's ctid identifies the selected versions only within this statement.
    // Keep the locked CTE, and use a subquery because SeaQuery has no DELETE USING.
    let expired = Query::select()
        .column(Alias::new("ctid"))
        .from(E::default())
        .and_where(Expr::col(expiry).lt(cutoff))
        .order_by(expiry, Order::Asc)
        .limit(limit)
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .to_owned();
    let cte = CommonTableExpression::new()
        .table_name(Alias::new("expired"))
        .query(expired)
        .to_owned();
    let selected = Query::select()
        .column(Alias::new("ctid"))
        .from(Alias::new("expired"))
        .to_owned();
    Ok(db
        .execute(
            Query::delete()
                .from_table(E::default())
                .with_cte(cte)
                .and_where(Expr::col(Alias::new("ctid")).in_subquery(selected)),
        )
        .await?
        .rows_affected())
}
