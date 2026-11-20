//! Team billing for metered model usage in cloud Agent sessions.
use super::{Plan, period_at};
use crate::entities::cp_cloud_token_usage as ledger;
use crate::{ControlStore, Error, Result, now_ms, one_query, resource_id, timestamp};
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, ExprTrait, Func, OnConflict, Query};
use sea_orm::{ActiveModelTrait, DbErr, EntityTrait, NotSet, Set};
use serde::Serialize;

/// An incremental usage record at an immutable position in the root eve session stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloudTokenEvent {
    pub session_id: String,
    pub line: i64,
    pub index: i32,
    /// Source event time in UTC milliseconds, including for delayed delivery.
    pub occurred_at: i64,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// Optional breakdowns already included in input tokens.
    pub cached_read_tokens: Option<i64>,
    pub cached_write_tokens: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudTokenPeriod {
    pub start: String,
    pub end: String,
    pub plan: Plan,
    pub included_tokens: Option<u64>,
    pub used_tokens: u64,
    pub included_credits: Option<u64>,
    /// Total credits charged in this period, as an exact decimal.
    pub used_credits: String,
    pub admitted: bool,
}

impl ControlStore {
    /// Record a trusted usage event. Exact redelivery returns false.
    ///
    /// # Errors
    /// Rejects invalid counts or source positions, conflicting replays and database failures.
    pub async fn record_cloud_token_usage(
        &self,
        team_id: &str,
        event: &CloudTokenEvent,
    ) -> Result<bool> {
        let team = resource_id(team_id)?;
        if event.session_id.is_empty()
            || event.line < 0
            || event.index < 0
            || chrono::DateTime::from_timestamp_millis(event.occurred_at).is_none()
            || event.input_tokens < 0
            || event.output_tokens < 0
            || event.cached_read_tokens.is_some_and(|value| value < 0)
            || event.cached_write_tokens.is_some_and(|value| value < 0)
        {
            return Err(Error::Invalid("invalid cloud token usage event"));
        }
        let record = ledger::ActiveModel {
            team_id: Set(team),
            session_id: Set(event.session_id.clone()),
            line: Set(event.line),
            event_index: Set(event.index),
            occurred_at: Set(event.occurred_at),
            model: Set(event.model.clone()),
            input_tokens: Set(event.input_tokens),
            output_tokens: Set(event.output_tokens),
            cached_read_tokens: Set(event.cached_read_tokens),
            cached_write_tokens: Set(event.cached_write_tokens),
            charged_credits: NotSet,
        };
        let inserted = ledger::Entity::insert(record.clone())
            .on_conflict(
                OnConflict::columns([
                    ledger::Column::TeamId,
                    ledger::Column::SessionId,
                    ledger::Column::Line,
                    ledger::Column::EventIndex,
                ])
                .do_nothing()
                .to_owned(),
            )
            .exec_without_returning(&self.db)
            .await?;
        if inserted == 1 {
            return Ok(true);
        }
        let stored =
            ledger::Entity::find_by_id((team, event.session_id.clone(), event.line, event.index))
                .one(&self.db)
                .await?
                .ok_or(Error::NotFound)?;
        // The charge belongs to the first insert; replay identity covers the provider's facts.
        let mut stored = ledger::ActiveModel::from(stored).reset_all();
        stored.charged_credits = NotSet;
        if stored != record {
            return Err(Error::Conflict("cloud_token_event_conflict"));
        }
        Ok(false)
    }

    /// Summarize this Team's current billing month at its effective plan.
    /// The soft admission decision applies to new turns. Accepted turns report all usage.
    ///
    /// # Errors
    /// Returns an error for an unknown Team or an unreadable ledger.
    pub async fn cloud_token_period(&self, team_id: &str) -> Result<CloudTokenPeriod> {
        let profile = self.billing_profile(team_id).await?;
        let now = now_ms();
        let plan = profile.effective_plan(self.hosted, now);
        let (start, end) = period_at(profile.period_anchor, now);
        let total = Expr::col(ledger::Column::InputTokens)
            .sum()
            .add(Expr::col(ledger::Column::OutputTokens).sum());
        // PostgreSQL returns numeric for SUM(bigint). Decode the exact integral value.
        let row = one_query(
            &self.db,
            Query::select()
                .expr_as(Func::coalesce([total, Expr::val(0)]), "tokens")
                .expr_as(
                    Func::coalesce([
                        Expr::col(ledger::Column::ChargedCredits).sum(),
                        Expr::val(0),
                    ]),
                    "credits",
                )
                .from(ledger::Entity)
                .and_where(Expr::col(ledger::Column::TeamId).eq(resource_id(team_id)?))
                .and_where(Expr::col(ledger::Column::OccurredAt).gte(start))
                .and_where(Expr::col(ledger::Column::OccurredAt).lt(end)),
        )
        .await?;
        let used: sea_orm::prelude::Decimal = row.try_get("", "tokens")?;
        let used_credits: BigDecimal = row.try_get("", "credits")?;
        let used_tokens = u64::try_from(used)
            .map_err(|_| DbErr::Type("cloud token total exceeds the supported range".into()))?;
        let included_tokens = self
            .plan_limits(plan)
            .await?
            .super_agent_tokens
            .map(u64::try_from)
            .transpose()
            .map_err(|_| DbErr::Type("negative monthly credit allowance".into()))?;
        let admitted = included_tokens.is_none_or(|limit| used_credits < BigDecimal::from(limit));
        Ok(CloudTokenPeriod {
            start: timestamp(start),
            end: timestamp(end),
            plan,
            used_tokens,
            included_tokens,
            included_credits: included_tokens,
            used_credits: used_credits.normalized().to_plain_string(),
            admitted,
        })
    }
}
