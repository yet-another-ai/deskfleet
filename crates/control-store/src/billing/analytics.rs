//! Durable, idempotent billing facts, independently delivered to analytics.
use crate::{ControlStore, Result, now_ms, resource_id, sql};
use sea_orm::ConnectionTrait;
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
    for event in events {
        db.execute_raw(sql(
            "INSERT INTO cp_billing_analytics(event_id,team_id,event,available_at) VALUES($1,$2,$3,$4) ON CONFLICT(event_id) DO NOTHING",
            vec![event.id.clone().into(), team.into(), serde_json::to_value(event)?.into(), now_ms().into()],
        )).await?;
    }
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
        let row = self.db.query_one_raw(sql(
            "UPDATE cp_billing_analytics e SET attempts=LEAST(attempts+1,30),claim_token=$2,claimed_until=$1+30000 FROM (SELECT event_id FROM cp_billing_analytics WHERE sent_at IS NULL AND available_at<=$1 AND (claimed_until IS NULL OR claimed_until<$1) ORDER BY available_at,event_id FOR UPDATE SKIP LOCKED LIMIT 1) candidate WHERE e.event_id=candidate.event_id RETURNING e.event,e.team_id",
            vec![now_ms().into(),token.clone().into()],
        )).await?;
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
        self.db.execute_raw(sql(
            "UPDATE cp_billing_analytics SET sent_at=CASE WHEN $3 THEN $4 ELSE NULL END,claim_token=NULL,claimed_until=NULL,available_at=$4+LEAST(3600000,power(2,LEAST(attempts,12))::bigint*1000) WHERE event_id=$1 AND claim_token=$2",
            vec![delivery.event.id.clone().into(), delivery.claim_token.clone().into(), success.into(), now_ms().into()],
        )).await?;
        Ok(())
    }
}
