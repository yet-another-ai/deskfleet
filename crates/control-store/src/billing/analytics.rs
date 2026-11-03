//! Durable, idempotent billing facts, independently delivered to analytics.
use crate::entities::cp_billing_analytics as analytics;
use crate::{ControlStore, Result, now_ms, resource_id};
use sea_orm::ConnectionTrait;
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{
    Cond, Expr, ExprTrait, Func, IntoIden, LockBehavior, LockType, OnConflict, Order, Query,
    TableRef,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Only verified billing facts and explicitly selected non-PII dimensions belong here.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BillingAnalyticsEvent {
    pub id: String,
    pub name: String,
    pub user_id: Option<String>,
    pub time: i64,
    pub value: Option<i64>,
    pub metadata: BTreeMap<String, String>,
}

/// A fenced delivery claim. The serialized event is immutable across retries.
pub struct BillingAnalyticsDelivery {
    pub event: BillingAnalyticsEvent,
    pub team_id: String,
    pub claim_token: String,
}

pub(super) async fn enqueue(
    db: &impl ConnectionTrait,
    team_id: &str,
    events: &[BillingAnalyticsEvent],
) -> Result<()> {
    let team = resource_id(team_id)?;
    if events.is_empty() {
        return Ok(());
    }
    // One atomic insert avoids per-event round trips and acquires conflicting
    // event keys in a consistent order. The first occurrence still wins.
    let rows = events
        .iter()
        .enumerate()
        .map(|(position, event)| {
            Ok(serde_json::json!({"position": position, "event": serde_json::to_value(event)?}))
        })
        .collect::<Result<Vec<_>>>()?;
    let item = Expr::col(("events", "value"));
    let event = item.clone().get_json_field("event");
    let records = Query::select()
        .expr(event.clone().cast_json_field("id"))
        .expr(Expr::val(team))
        .expr(event.clone())
        .expr(Expr::val(now_ms()))
        .from_function(
            Func::cust("jsonb_array_elements").arg(Expr::val(serde_json::json!(rows))),
            "events",
        )
        .order_by_expr(event.cast_json_field("id"), Order::Asc)
        .order_by_expr(
            item.cast_json_field("position").cast_as("bigint"),
            Order::Asc,
        )
        .to_owned();
    db.execute(
        Query::insert()
            .into_table(analytics::Entity)
            .columns([
                analytics::Column::EventId,
                analytics::Column::TeamId,
                analytics::Column::Event,
                analytics::Column::AvailableAt,
            ])
            .select_from(records)
            .expect("four selected billing analytics columns")
            .on_conflict(
                OnConflict::column(analytics::Column::EventId)
                    .do_nothing()
                    .to_owned(),
            ),
    )
    .await?;
    Ok(())
}

impl ControlStore {
    /// Records billing facts once even when multiple provider events describe one invoice.
    pub async fn record_billing_analytics(
        &self,
        team: &str,
        events: &[BillingAnalyticsEvent],
    ) -> Result<()> {
        enqueue(&self.db, team, events).await
    }

    /// Claims one due event across API replicas without holding a lock during HTTP I/O.
    pub async fn claim_billing_analytics(&self) -> Result<Option<BillingAnalyticsDelivery>> {
        let token = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let candidate = Query::select()
            .column(analytics::Column::EventId)
            .from(analytics::Entity)
            .and_where(Expr::col(analytics::Column::SentAt).is_null())
            .and_where(Expr::col(analytics::Column::AvailableAt).lte(now))
            .cond_where(
                Cond::any()
                    .add(Expr::col(analytics::Column::ClaimedUntil).is_null())
                    .add(Expr::col(analytics::Column::ClaimedUntil).lt(now)),
            )
            .order_by(analytics::Column::AvailableAt, Order::Asc)
            .order_by(analytics::Column::EventId, Order::Asc)
            .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
            .limit(1)
            .to_owned();
        let row = self
            .db
            .query_one(
                Query::update()
                    .table(analytics::Entity)
                    .value(
                        analytics::Column::Attempts,
                        Func::least([Expr::col(analytics::Column::Attempts).add(1), Expr::val(30)]),
                    )
                    .value(analytics::Column::ClaimToken, token.clone())
                    .value(analytics::Column::ClaimedUntil, now + 30_000)
                    .from(TableRef::SubQuery(
                        Box::new(candidate),
                        "candidate".into_iden(),
                    ))
                    .and_where(
                        Expr::col((analytics::Entity, analytics::Column::EventId))
                            .eq(Expr::col(("candidate", analytics::Column::EventId))),
                    )
                    .returning(
                        Query::returning()
                            .columns([
                                (analytics::Entity, analytics::Column::Event),
                                (analytics::Entity, analytics::Column::TeamId),
                            ])
                            .to_owned(),
                    ),
            )
            .await?;
        row.map(|row| {
            Ok(BillingAnalyticsDelivery {
                event: serde_json::from_value(row.try_get("", "event")?)?,
                team_id: row.try_get::<i64>("", "team_id")?.to_string(),
                claim_token: token,
            })
        })
        .transpose()
    }

    /// Failure leaves the same event available for a later delivery attempt.
    pub async fn finish_billing_analytics(
        &self,
        delivery: &BillingAnalyticsDelivery,
        success: bool,
    ) -> Result<()> {
        let now = now_ms();
        let delay = Func::least([
            Expr::val(3_600_000),
            Func::cust("power")
                .args([
                    Expr::val(2),
                    Func::least([Expr::col(analytics::Column::Attempts), Expr::val(12)]).into(),
                ])
                .cast_as("bigint")
                .mul(1000),
        ]);
        self.db
            .execute(
                Query::update()
                    .table(analytics::Entity)
                    .value(analytics::Column::SentAt, success.then_some(now))
                    .value(analytics::Column::ClaimToken, Option::<String>::None)
                    .value(analytics::Column::ClaimedUntil, Option::<i64>::None)
                    .value(analytics::Column::AvailableAt, Expr::val(now).add(delay))
                    .and_where(Expr::col(analytics::Column::EventId).eq(delivery.event.id.clone()))
                    .and_where(
                        Expr::col(analytics::Column::ClaimToken).eq(delivery.claim_token.clone()),
                    ),
            )
            .await?;
        Ok(())
    }
}
