//! Server-verified billing events. Delivery never runs on a billing request path.
use super::{BillingService, gateway::stripe_id};
use crate::error::{ApiError, Result};
use deskfleet_control_store::{
    ControlStore,
    billing::{
        BillingAnalyticsDelivery, BillingAnalyticsEvent, BillingProfile, CheckoutAttempt,
        PaymentEvent, SubscriptionProjection,
    },
    now_ms,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
use tokio::time::{MissedTickBehavior, interval};

const STATSIG_EVENTS_URL: &str = "https://api.statsig.com/v1/log_event";

fn event(id: String, name: &str, actor: Option<String>, time: i64) -> BillingAnalyticsEvent {
    BillingAnalyticsEvent {
        id,
        name: name.into(),
        user_id: actor,
        time,
        value: None,
        metadata: BTreeMap::new(),
    }
}

fn seconds(value: &Value) -> Option<i64> {
    value.as_i64()?.checked_mul(1000)
}

impl BillingService {
    fn analytics_enabled(&self) -> bool {
        self.config.statsig_server_key.is_some()
    }

    pub(super) fn checkout_analytics(
        &self,
        attempt: &CheckoutAttempt,
    ) -> Option<BillingAnalyticsEvent> {
        if !self.analytics_enabled() {
            return None;
        }
        let mut fact = event(
            format!("checkout:{}", attempt.request_id),
            "billing_checkout_created",
            attempt.actor_user_id.clone(),
            attempt.created_at,
        );
        fact.metadata.insert("plan".into(), attempt.plan.clone());
        fact.metadata
            .insert("request_id".into(), attempt.request_id.clone());
        fact.metadata
            .insert("interval".into(), attempt.billing_interval.clone());
        fact.metadata
            .insert("attribution".into(), "authenticated_actor".into());
        Some(fact)
    }

    pub(super) async fn record_portal(
        &self,
        store: &ControlStore,
        team: &str,
        actor: &str,
        session: &Value,
    ) -> Result<()> {
        if !self.analytics_enabled() {
            return Ok(());
        }
        let id = stripe_id(session).ok_or_else(ApiError::internal)?;
        let mut fact = event(
            format!("portal:{id}"),
            "billing_portal_opened",
            Some(actor.into()),
            now_ms(),
        );
        fact.metadata
            .insert("attribution".into(), "authenticated_actor".into());
        store.record_billing_analytics(team, &[fact]).await?;
        Ok(())
    }

    async fn checkout_actor(
        &self,
        store: &ControlStore,
        team: &str,
        subscription: &Value,
    ) -> Result<Option<String>> {
        let Some(request) = subscription["metadata"]["deskfleet_request_id"].as_str() else {
            return Ok(None);
        };
        Ok(store
            .checkout_attempt(request)
            .await?
            .filter(|attempt| attempt.team_id == team)
            .and_then(|attempt| attempt.actor_user_id))
    }

    /// Invoice identity, ownership, configured Price and provider status establish
    /// payment. Neither a Checkout redirect nor subscription `active` is evidence.
    pub(super) async fn invoice_analytics(
        &self,
        store: &ControlStore,
        profile: &BillingProfile,
        subscription: &Value,
        invoice: &Value,
        webhook: Option<&PaymentEvent>,
        validated_price: Option<&Value>,
    ) -> Result<Option<BillingAnalyticsEvent>> {
        if !self.analytics_enabled() {
            return Ok(None);
        }
        let Some(invoice_id) = stripe_id(invoice) else {
            return Ok(None);
        };
        let Some(subscription_id) = stripe_id(subscription) else {
            return Ok(None);
        };
        let invoice_subscription = stripe_id(&invoice["subscription"])
            .or_else(|| stripe_id(&invoice["parent"]["subscription_details"]["subscription"]));
        if stripe_id(&invoice["customer"]) != profile.customer_id.as_deref()
            || stripe_id(&subscription["customer"]) != profile.customer_id.as_deref()
            || subscription["metadata"]["deskfleet_team_id"] != profile.team_id
            || invoice_subscription != Some(subscription_id)
            || invoice["lines"]["has_more"] == true
        {
            return Ok(None);
        }
        let price_id = invoice["lines"]["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|line| line["amount"].as_i64().is_some_and(|amount| amount >= 0))
            .filter_map(|line| {
                let id = stripe_id(&line["price"])
                    .or_else(|| stripe_id(&line["pricing"]["price_details"]["price"]))?;
                self.config.plan_for_price(id)?;
                Some((id, line["amount"].as_i64().unwrap_or(0)))
            })
            .max_by_key(|(_, amount)| *amount)
            .map(|(id, _)| id);
        let Some(price_id) = price_id else {
            return Ok(None);
        };
        let plan = self
            .config
            .plan_for_price(price_id)
            .ok_or_else(ApiError::internal)?;
        let interval = self
            .config
            .interval_for_price(price_id)
            .ok_or_else(ApiError::internal)?;
        // Reconciliation already verified its current Price. Historical invoice
        // webhooks fetch their own Price, which may differ after a plan change.
        let fetched_price;
        let price = if let Some(price) = validated_price {
            if stripe_id(price) != Some(price_id) {
                return Ok(None);
            }
            price
        } else {
            fetched_price = self.configured_price(plan, interval).await?;
            &fetched_price
        };
        if invoice["currency"] != price["currency"] {
            return Ok(None);
        }
        let actor = self
            .checkout_actor(store, &profile.team_id, subscription)
            .await?;
        Ok(invoice_fact(
            invoice, invoice_id, actor, plan, interval, webhook,
        ))
    }

    /// The outbox insert and subscription projection commit together. Comparing
    /// the previous projection makes repeated webhooks/repair passes no-ops.
    pub(super) async fn subscription_analytics(
        &self,
        store: &ControlStore,
        profile: &BillingProfile,
        subscription: &Value,
        projection: &SubscriptionProjection,
    ) -> Result<Vec<BillingAnalyticsEvent>> {
        if !self.analytics_enabled() {
            return Ok(Vec::new());
        }
        let actor = self
            .checkout_actor(store, &profile.team_id, subscription)
            .await?;
        let same = profile.subscription_id.as_deref() == Some(&projection.subscription_id);
        let mut names = Vec::new();
        if projection.cancel_at_period_end && (!same || !profile.cancel_at_period_end) {
            names.push("billing_subscription_cancel_scheduled");
        } else if same
            && profile.cancel_at_period_end
            && !projection.cancel_at_period_end
            && !matches!(
                projection.status.as_str(),
                "canceled" | "incomplete_expired"
            )
        {
            names.push("billing_subscription_cancel_reverted");
        }
        if projection.status == "canceled"
            && (!same || profile.subscription_status.as_deref() != Some("canceled"))
        {
            names.push("billing_subscription_ended");
        }
        Ok(names
            .into_iter()
            .map(|name| {
                let mut fact = event(
                    uuid::Uuid::new_v4().to_string(),
                    name,
                    actor.clone(),
                    now_ms(),
                );
                fact.metadata.insert(
                    "attribution".into(),
                    if actor.is_some() {
                        "checkout_actor"
                    } else {
                        "team_only"
                    }
                    .into(),
                );
                if let Some(plan) = projection.paid_plan.as_ref().or(profile.plan.as_ref()) {
                    fact.metadata.insert("plan".into(), plan.clone());
                }
                fact
            })
            .collect())
    }

    pub(super) async fn run_analytics(&self, store: ControlStore) {
        if !self.enabled() || !self.analytics_enabled() {
            return;
        }
        let mut tick = interval(Duration::from_secs(5));
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            for _ in 0..25 {
                let delivery = match store.claim_billing_analytics().await {
                    Ok(Some(delivery)) => delivery,
                    Ok(None) => break,
                    Err(_) => {
                        tracing::warn!("billing analytics outbox is unavailable");
                        break;
                    }
                };
                let success = self.deliver_analytics(&delivery, STATSIG_EVENTS_URL).await;
                if !success {
                    tracing::warn!("billing analytics delivery failed; scheduled retry");
                }
                if store
                    .finish_billing_analytics(&delivery, success)
                    .await
                    .is_err()
                {
                    tracing::warn!("billing analytics delivery result could not be persisted");
                }
            }
        }
    }

    async fn deliver_analytics(&self, delivery: &BillingAnalyticsDelivery, endpoint: &str) -> bool {
        let Some(key) = self.config.statsig_server_key.as_deref() else {
            return false;
        };
        let environment = self
            .config
            .statsig_environment
            .as_deref()
            .unwrap_or("production");
        let response = self
            .client
            .post(endpoint)
            .timeout(Duration::from_secs(5))
            .header("statsig-api-key", key)
            .json(&request_body(delivery, environment))
            .send()
            .await;
        let Ok(response) = response else {
            return false;
        };
        response.status().is_success()
            && response
                .json::<Value>()
                .await
                .is_ok_and(|body| body["success"] == true)
    }
}

fn invoice_fact(
    invoice: &Value,
    id: &str,
    actor: Option<String>,
    plan: &str,
    interval: &str,
    webhook: Option<&PaymentEvent>,
) -> Option<BillingAnalyticsEvent> {
    let failure = webhook.filter(|event| event.event_type == "invoice.payment_failed");
    let mut fact = if let Some(failure) = failure {
        // The signed webhook preserves the failed attempt even if the fetched
        // invoice has since been paid; a later success is a separate fact.
        let suffix = failure
            .payment_attempt
            .map(|n| n.to_string())
            .unwrap_or_else(|| failure.id.clone());
        let mut fact = event(
            format!("invoice:{id}:failed:{suffix}"),
            "billing_invoice_payment_failed",
            actor,
            failure.occurred_at?,
        );
        fact.value = invoice["amount_due"].as_i64().filter(|value| *value >= 0);
        fact
    } else {
        if invoice["status"] != "paid" || invoice["paid"] != true {
            return None;
        }
        let amount = invoice["amount_paid"]
            .as_i64()
            .filter(|value| *value >= 0)?;
        let mut fact = event(
            format!("invoice:{id}:paid"),
            "billing_invoice_paid",
            actor,
            seconds(&invoice["status_transitions"]["paid_at"])?,
        );
        fact.value = Some(amount);
        fact
    };
    let reason = match invoice["billing_reason"].as_str() {
        Some("subscription_create") => "subscription_create",
        Some("subscription_cycle") => "subscription_cycle",
        Some("subscription_update") => "subscription_update",
        _ => "other",
    };
    fact.metadata.insert("plan".into(), plan.into());
    fact.metadata.insert("interval".into(), interval.into());
    fact.metadata.insert("billing_reason".into(), reason.into());
    fact.metadata
        .insert("currency".into(), invoice["currency"].as_str()?.into());
    fact.metadata.insert(
        "attribution".into(),
        if fact.user_id.is_some() {
            "checkout_actor"
        } else {
            "team_only"
        }
        .into(),
    );
    Some(fact)
}

fn request_body(delivery: &BillingAnalyticsDelivery, environment: &str) -> Value {
    let fact = &delivery.event;
    let mut metadata = fact.metadata.clone();
    metadata.insert("event_id".into(), fact.id.clone());
    metadata.insert("source".into(), "server".into());
    let mut user =
        json!({"customIDs":{"teamID":delivery.team_id},"statsigEnvironment":{"tier":environment}});
    if let Some(id) = fact.user_id.as_ref() {
        user["userID"] = json!(id);
    }
    let mut event = json!({"eventName":fact.name,"time":fact.time,"user":user,"metadata":metadata});
    if let Some(value) = fact.value {
        event["value"] = json!(value);
    }
    json!({"events":[event]})
}

#[cfg(test)]
mod tests;
