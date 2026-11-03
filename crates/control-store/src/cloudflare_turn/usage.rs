use super::CloudflareTurnConfig;
use super::metering::incomplete_usage;
use crate::entities::{
    cp_billing_profiles as profiles, cp_cloudflare_turn_collector as collector,
    cp_cloudflare_turn_sources as sources, cp_cloudflare_turn_usage as usage,
};
use crate::{ControlStore, Error, Result, billing::period_at, now_ms, one_query, resource_id};
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{
    Asterisk, Cond, Expr, ExprTrait, Func, JoinType, NullOrdering, OnConflict, Order, Query,
};
use sea_orm::{ConnectionTrait, TransactionTrait};

fn lease(owner: &str, now: i64) -> Expr {
    Expr::exists(
        Query::select()
            .expr(Expr::val(1))
            .from(collector::Entity)
            .and_where(Expr::col(collector::Column::Singleton))
            .and_where(Expr::col(collector::Column::Owner).eq(owner))
            .and_where(Expr::col(collector::Column::LeaseUntil).gt(now))
            .to_owned(),
    )
}
use serde_json::json;

/// One aggregate query for a Team, TURN key, and billing period. Credentials stay internal.
pub struct CloudflareTurnUsageQuery {
    pub identifier: String,
    pub team_id: String,
    pub account_id: String,
    pub key_id: String,
    pub analytics_token: String,
    pub period_start: i64,
    pub period_end: i64,
    pub query_end: i64,
    pub expires_at: i64,
}

impl ControlStore {
    /// Retain the identifier across credentials and replicas; retain analytics access
    /// through the final backfill even when the administrator disables or rotates TURN.
    pub async fn prepare_cloudflare_turn_usage(
        &self,
        team_id: &str,
        config: &CloudflareTurnConfig,
        expires_at: i64,
    ) -> Result<String> {
        let now = now_ms();
        if !config.enabled || config.analytics_token.is_empty() || expires_at <= now {
            return Err(Error::Invalid("invalid Cloudflare TURN usage registration"));
        }
        let profile = self.billing_profile(team_id).await?;
        let tx = self.db.begin().await?;
        let unfinished = Query::select()
            .expr(Expr::val(1))
            .from(usage::Entity)
            .and_where(
                Expr::col((usage::Entity, usage::Column::Identifier))
                    .eq(Expr::col((sources::Entity, sources::Column::Identifier))),
            )
            .and_where(Expr::col((usage::Entity, usage::Column::PeriodStart)).lte(now))
            .and_where(Expr::col((usage::Entity, usage::Column::PeriodEnd)).gt(now))
            .cond_where(incomplete_usage())
            .to_owned();
        let identifier: String = one_query(
            &tx,
            Query::insert()
                .into_table(sources::Entity)
                .columns([
                    sources::Column::Identifier,
                    sources::Column::TeamId,
                    sources::Column::AccountId,
                    sources::Column::KeyId,
                    sources::Column::AnalyticsToken,
                    sources::Column::ExpiresAt,
                    sources::Column::CreatedAt,
                ])
                .values_panic([
                    uuid::Uuid::new_v4().simple().to_string().into(),
                    resource_id(team_id)?.into(),
                    config.account_id.as_str().into(),
                    config.key_id.as_str().into(),
                    config.analytics_token.as_str().into(),
                    expires_at.into(),
                    now.into(),
                ])
                .on_conflict(
                    OnConflict::columns([
                        sources::Column::TeamId,
                        sources::Column::AccountId,
                        sources::Column::KeyId,
                    ])
                    .update_column(sources::Column::AnalyticsToken)
                    .value(
                        sources::Column::CreatedAt,
                        Expr::case(
                            Expr::col((sources::Entity, sources::Column::ExpiresAt))
                                .lt(now)
                                .and(Expr::exists(unfinished).not()),
                            now,
                        )
                        .finally(Expr::col((sources::Entity, sources::Column::CreatedAt))),
                    )
                    .value(
                        sources::Column::ExpiresAt,
                        Func::greatest([
                            Expr::col((sources::Entity, sources::Column::ExpiresAt)),
                            Expr::col(("excluded", sources::Column::ExpiresAt)),
                        ]),
                    )
                    .to_owned(),
                )
                .returning_col(sources::Column::Identifier),
        )
        .await?
        .try_get("", "identifier")?;
        let mut start = period_at(profile.period_anchor, now).0;
        while start < expires_at {
            let (_, end) = period_at(profile.period_anchor, start);
            tx.execute(
                Query::insert()
                    .into_table(usage::Entity)
                    .columns([
                        usage::Column::Identifier,
                        usage::Column::PeriodStart,
                        usage::Column::PeriodEnd,
                        usage::Column::ExpiresAt,
                    ])
                    .values_panic([
                        identifier.as_str().into(),
                        start.into(),
                        end.into(),
                        std::cmp::min(expires_at, end).into(),
                    ])
                    .on_conflict(
                        OnConflict::columns([
                            usage::Column::Identifier,
                            usage::Column::PeriodStart,
                            usage::Column::PeriodEnd,
                        ])
                        .value(
                            usage::Column::ExpiresAt,
                            Func::greatest([
                                Expr::col((usage::Entity, usage::Column::ExpiresAt)),
                                Expr::col(("excluded", usage::Column::ExpiresAt)),
                            ]),
                        )
                        .to_owned(),
                    ),
            )
            .await?;
            start = end;
        }
        tx.commit().await?;
        Ok(identifier)
    }

    /// Poll complete aggregates, never sum sampled minute buckets. A period gets a
    /// final refresh after five minutes, and updates replace its previous snapshot.
    pub async fn cloudflare_turn_usage_queries(
        &self,
        now: i64,
        limit: usize,
    ) -> Result<Vec<CloudflareTurnUsageQuery>> {
        // A replacement subscription can move the billing anchor without issuing
        // another credential. Retain analytics access for the maximum monthly
        // lookback so even a previously finalized source can be queried again.
        self.db
            .execute(
                Query::update()
                    .table(sources::Entity)
                    .value(sources::Column::AnalyticsToken, "")
                    .and_where(Expr::col(sources::Column::ExpiresAt).lt(now - 2_764_800_000_i64))
                    .and_where(Expr::col(sources::Column::AnalyticsToken).ne("")),
            )
            .await?;
        let mut periods = Vec::new();
        for row in self
            .db
            .query_all(
                Query::select()
                    .columns([
                        (sources::Entity, sources::Column::Identifier),
                        (sources::Entity, sources::Column::ExpiresAt),
                    ])
                    .column((profiles::Entity, profiles::Column::PeriodAnchor))
                    .from(sources::Entity)
                    .join(
                        JoinType::InnerJoin,
                        profiles::Entity,
                        Expr::col((profiles::Entity, profiles::Column::TeamId))
                            .eq(Expr::col((sources::Entity, sources::Column::TeamId))),
                    )
                    .and_where(
                        Expr::col((sources::Entity, sources::Column::AnalyticsToken)).ne(""),
                    ),
            )
            .await?
        {
            let (start, end) = period_at(row.try_get("", "period_anchor")?, now);
            let expires: i64 = row.try_get("", "expires_at")?;
            if expires > start {
                periods.push(json!({"identifier":row.try_get::<String>("","identifier")?,"period_start":start,"period_end":end,"expires_at":std::cmp::min(expires, end)}));
            }
        }
        if !periods.is_empty() {
            let item = Expr::col(("periods", "value"));
            let selected = Query::select()
                .expr(item.clone().cast_json_field("identifier"))
                .expr(
                    item.clone()
                        .cast_json_field("period_start")
                        .cast_as("bigint"),
                )
                .expr(item.clone().cast_json_field("period_end").cast_as("bigint"))
                .expr(item.cast_json_field("expires_at").cast_as("bigint"))
                .from_function(
                    Func::cust("jsonb_array_elements").arg(Expr::val(json!(periods))),
                    "periods",
                )
                .to_owned();
            self.db
                .execute(
                    Query::insert()
                        .into_table(usage::Entity)
                        .columns([
                            usage::Column::Identifier,
                            usage::Column::PeriodStart,
                            usage::Column::PeriodEnd,
                            usage::Column::ExpiresAt,
                        ])
                        .select_from(selected)
                        .expect("four selected usage period columns")
                        .on_conflict(OnConflict::new().do_nothing().to_owned()),
                )
                .await?;
        }
        self.db
            .query_all(
                Query::select()
                    .column((sources::Entity, Asterisk))
                    .columns([
                        (usage::Entity, usage::Column::PeriodStart),
                        (usage::Entity, usage::Column::PeriodEnd),
                    ])
                    .expr_as(
                        Expr::col((usage::Entity, usage::Column::ExpiresAt)),
                        "window_expires_at",
                    )
                    .expr_as(
                        Func::least([
                            Expr::val(now),
                            Expr::col((usage::Entity, usage::Column::ExpiresAt)),
                        ]),
                        "query_end",
                    )
                    .from(usage::Entity)
                    .join(
                        JoinType::InnerJoin,
                        sources::Entity,
                        Expr::col((sources::Entity, sources::Column::Identifier))
                            .eq(Expr::col((usage::Entity, usage::Column::Identifier))),
                    )
                    .and_where(Expr::col((sources::Entity, sources::Column::AnalyticsToken)).ne(""))
                    .and_where(Expr::col((usage::Entity, usage::Column::PeriodStart)).lt(now))
                    .cond_where(
                        Cond::any()
                            .add(Expr::col((usage::Entity, usage::Column::LastAttemptAt)).is_null())
                            .add(
                                Expr::col((usage::Entity, usage::Column::LastAttemptAt))
                                    .lte(now - 60_000),
                            ),
                    )
                    .cond_where(incomplete_usage())
                    .order_by_with_nulls(
                        (usage::Entity, usage::Column::LastAttemptAt),
                        Order::Asc,
                        NullOrdering::First,
                    )
                    .order_by((usage::Entity, usage::Column::PeriodStart), Order::Asc)
                    .order_by((sources::Entity, sources::Column::Identifier), Order::Asc)
                    .limit(limit.clamp(1, 1000) as u64),
            )
            .await?
            .into_iter()
            .map(|row| {
                Ok(CloudflareTurnUsageQuery {
                    identifier: row.try_get("", "identifier")?,
                    team_id: row.try_get::<i64>("", "team_id")?.to_string(),
                    account_id: row.try_get("", "account_id")?,
                    key_id: row.try_get("", "key_id")?,
                    analytics_token: row.try_get("", "analytics_token")?,
                    period_start: row.try_get("", "period_start")?,
                    period_end: row.try_get("", "period_end")?,
                    query_end: row.try_get("", "query_end")?,
                    expires_at: row.try_get("", "window_expires_at")?,
                })
            })
            .collect()
    }

    /// Lease fencing prevents a stale replica overwriting a newer aggregate.
    pub async fn save_cloudflare_turn_usage(
        &self,
        query: &CloudflareTurnUsageQuery,
        egress_bytes: i64,
        owner: &str,
    ) -> Result<bool> {
        if egress_bytes < 0
            || query.query_end < query.period_start
            || query.query_end > query.period_end
        {
            return Err(Error::Invalid("invalid Cloudflare TURN usage snapshot"));
        }
        let now = now_ms();
        let tx = self.db.begin().await?;
        let changed = tx
            .execute(
                Query::update()
                    .table(usage::Entity)
                    .value(usage::Column::EgressBytes, egress_bytes)
                    .value(usage::Column::QueryEnd, query.query_end)
                    .value(usage::Column::CollectedAt, now)
                    .value(usage::Column::LastAttemptAt, now)
                    .and_where(Expr::col(usage::Column::Identifier).eq(query.identifier.as_str()))
                    .and_where(Expr::col(usage::Column::PeriodStart).eq(query.period_start))
                    .and_where(Expr::col(usage::Column::PeriodEnd).eq(query.period_end))
                    .and_where(lease(owner, now)),
            )
            .await?
            .rows_affected()
            == 1;
        tx.commit().await?;
        Ok(changed)
    }

    /// A failed source gets its own retry delay without starving other Teams or
    /// making its last successful usage snapshot appear fresh.
    pub async fn fail_cloudflare_turn_usage(
        &self,
        query: &CloudflareTurnUsageQuery,
        owner: &str,
    ) -> Result<bool> {
        let now = now_ms();
        Ok(self
            .db
            .execute(
                Query::update()
                    .table(usage::Entity)
                    .value(usage::Column::LastAttemptAt, now)
                    .and_where(Expr::col(usage::Column::Identifier).eq(query.identifier.as_str()))
                    .and_where(Expr::col(usage::Column::PeriodStart).eq(query.period_start))
                    .and_where(Expr::col(usage::Column::PeriodEnd).eq(query.period_end))
                    .and_where(lease(owner, now)),
            )
            .await?
            .rows_affected()
            == 1)
    }

    pub async fn claim_cloudflare_turn_collector(&self, owner: &str) -> Result<bool> {
        let now = now_ms();
        Ok(self
            .db
            .execute(
                Query::update()
                    .table(collector::Entity)
                    .value(collector::Column::Owner, owner)
                    .value(collector::Column::LeaseUntil, now + 45_000)
                    .and_where(Expr::col(collector::Column::Singleton))
                    .cond_where(
                        Cond::any()
                            .add(Expr::col(collector::Column::Owner).eq(owner))
                            .add(Expr::col(collector::Column::LeaseUntil).is_null())
                            .add(Expr::col(collector::Column::LeaseUntil).lt(now)),
                    ),
            )
            .await?
            .rows_affected()
            == 1)
    }

    /// Call after a successful analytics request, including a verified empty result.
    pub async fn heartbeat_cloudflare_turn_collector(&self, owner: &str) -> Result<bool> {
        let now = now_ms();
        Ok(self
            .db
            .execute(
                Query::update()
                    .table(collector::Entity)
                    .value(collector::Column::LeaseUntil, now + 45_000)
                    .value(collector::Column::LastSeenAt, now)
                    .and_where(Expr::col(collector::Column::Singleton))
                    .and_where(Expr::col(collector::Column::Owner).eq(owner))
                    .and_where(Expr::col(collector::Column::LeaseUntil).gt(now)),
            )
            .await?
            .rows_affected()
            == 1)
    }

    pub async fn cloudflare_turn_collector_gap(&self, owner: &str) -> Result<()> {
        let now = now_ms();
        self.db
            .execute(
                Query::update()
                    .table(collector::Entity)
                    .value(
                        collector::Column::GapSince,
                        Func::coalesce([Expr::col(collector::Column::GapSince), Expr::val(now)]),
                    )
                    .value(collector::Column::LeaseUntil, now)
                    .and_where(Expr::col(collector::Column::Singleton))
                    .and_where(Expr::col(collector::Column::Owner).eq(owner)),
            )
            .await?;
        Ok(())
    }
}
