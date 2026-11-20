//! Durable client-operation receipts for the hosted Agent HTTP boundary.
use crate::{
    ControlStore, Error, Result, entities::cp_cloud_agent_requests as requests, now_ms, resource_id,
};
use sea_orm::sea_query::{Cond, Expr, OnConflict, Query};
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect};

impl ControlStore {
    /// Reserve an admitted operation, or load its original receipt for a replay.
    pub async fn cloud_agent_request(
        &self,
        team: &str,
        key: &str,
        fingerprint: &str,
        session: Option<&str>,
        admitted: bool,
    ) -> Result<Option<String>> {
        let team = resource_id(team)?;
        if admitted {
            self.db
                .execute(
                    Query::insert()
                        .into_table(requests::Entity)
                        .columns([
                            requests::Column::Id,
                            requests::Column::TeamId,
                            requests::Column::Fingerprint,
                            requests::Column::SessionId,
                        ])
                        .values_panic([key.into(), team.into(), fingerprint.into(), session.into()])
                        .on_conflict(
                            OnConflict::column(requests::Column::Id)
                                .do_nothing()
                                .to_owned(),
                        ),
                )
                .await?;
        }
        let row = requests::Entity::find_by_id(key)
            .filter(requests::Column::TeamId.eq(team))
            .one(&self.db)
            .await?
            .ok_or(Error::Limited("monthly token allowance exhausted"))?;
        if row.fingerprint != fingerprint || row.session_id.as_deref() != session {
            return Err(Error::Conflict(
                "operation ID already used for another request",
            ));
        }
        if session.is_none() && row.result_id.is_none() {
            return self.claim_cloud_prewarm(key).await;
        }
        // Eve remembers 1,024 message keys. A retry lacking a saved response can
        // no longer rely on that window if enough newer messages were admitted.
        if let Some(session) = session
            && row.result_id.is_none()
            && requests::Entity::find()
                .filter(requests::Column::SessionId.eq(session))
                .filter(requests::Column::Position.gt(row.position))
                .offset(1023)
                .limit(1)
                .one(&self.db)
                .await?
                .is_some()
        {
            return Err(Error::Conflict(
                "message delivery is uncertain beyond the replay window",
            ));
        }
        Ok(row.result_id)
    }

    /// Upstream create keys resolve to their active Session after startup.
    /// Serialize simultaneous prewarms while permitting recovery by another API process.
    async fn claim_cloud_prewarm(&self, key: &str) -> Result<Option<String>> {
        let now = now_ms();
        let claim = requests::Entity::update_many()
            .col_expr(requests::Column::PrewarmClaimUntil, Expr::val(now + 90_000))
            .filter(requests::Column::Id.eq(key))
            .filter(requests::Column::ResultId.is_null())
            .filter(
                Cond::any()
                    .add(requests::Column::PrewarmClaimUntil.is_null())
                    .add(requests::Column::PrewarmClaimUntil.lte(now)),
            )
            .exec(&self.db)
            .await?;
        if claim.rows_affected == 1 {
            return Ok(None);
        }
        requests::Entity::find_by_id(key)
            .one(&self.db)
            .await?
            .and_then(|row| row.result_id)
            .map(Some)
            .ok_or(Error::Conflict(
                "Super Agent session creation is in progress; retry the same operation",
            ))
    }

    /// Keep the first successful result when requests on different replicas race.
    pub async fn finish_cloud_agent_request(&self, key: &str, result_id: &str) -> Result<String> {
        requests::Entity::update_many()
            .col_expr(requests::Column::ResultId, Expr::val(result_id))
            .filter(requests::Column::Id.eq(key))
            .filter(requests::Column::ResultId.is_null())
            .exec(&self.db)
            .await?;
        requests::Entity::find_by_id(key)
            .one(&self.db)
            .await?
            .and_then(|row| row.result_id)
            .ok_or(Error::NotFound)
    }
}
