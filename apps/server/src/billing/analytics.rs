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
use deskfleet_protocol::control::MarketingAttribution;
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
use tokio::time::{MissedTickBehavior, interval};

const STATSIG_EVENTS_URL: &str = "https://api.statsig.com/v1/log_event";
const GA_MP_EVENTS_URL: &str = "https://www.google-analytics.com/mp/collect";

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
    pub(super) fn analytics_enabled(&self) -> bool {
        self.config.statsig_server_key.is_some() || self.ga_analytics_enabled()
    }

    fn ga_analytics_enabled(&self) -> bool {
        self.config.ga_measurement_id.is_some() && self.config.ga_api_secret.is_some()
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
        let invoice_subscription =
            stripe_id(&invoice["parent"]["subscription_details"]["subscription"]);
        if stripe_id(&invoice["customer"]) != profile.customer_id.as_deref()
            || stripe_id(&subscription["customer"]) != profile.customer_id.as_deref()
            || subscription["metadata"]["deskfleet_team_id"] != profile.team_id
            || invoice["parent"]["type"] != "subscription_details"
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
            .filter(|line| line["pricing"]["type"] == "price_details")
            .filter_map(|line| {
                let id = stripe_id(&line["pricing"]["price_details"]["price"])?;
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
            let Ok(settings) = store.site_settings().await else {
                tracing::warn!("site settings unavailable for billing analytics");
                continue;
            };
            for _ in 0..25 {
                let delivery = match store.claim_billing_analytics().await {
                    Ok(Some(delivery)) => delivery,
                    Ok(None) => break,
                    Err(_) => {
                        tracing::warn!("billing analytics outbox is unavailable");
                        break;
                    }
                };
                if !settings.telemetry_enabled {
                    // Drain queued items while site telemetry is off so they do not
                    // accumulate and flush in a burst if telemetry is later enabled.
                    if store
                        .finish_billing_analytics(&delivery, true)
                        .await
                        .is_err()
                    {
                        tracing::warn!("billing analytics drain result could not be persisted");
                    }
                    continue;
                }
                let is_ga_only = delivery.event.id.starts_with("ga:");
                let statsig_ok = if !is_ga_only && self.config.statsig_server_key.is_some() {
                    self.deliver_analytics(&delivery, STATSIG_EVENTS_URL).await
                } else {
                    true
                };
                if !statsig_ok {
                    tracing::warn!("billing analytics delivery failed; scheduled retry");
                    if store
                        .finish_billing_analytics(&delivery, false)
                        .await
                        .is_err()
                    {
                        tracing::warn!("billing analytics delivery result could not be persisted");
                    }
                    continue;
                }
                let ga_ok = if self.ga_analytics_enabled()
                    && is_ga_conversion_candidate(&delivery.event)
                {
                    match delivery.event.user_id.as_deref() {
                        Some(actor_id) => match store.user_marketing_attribution(actor_id).await {
                            Ok(Some(attribution)) => {
                                self.deliver_ga_conversion(
                                    &delivery,
                                    &attribution,
                                    GA_MP_EVENTS_URL,
                                )
                                .await
                            }
                            Ok(None) => true,
                            Err(_) => false,
                        },
                        None => true,
                    }
                } else {
                    true
                };
                let success = if ga_ok {
                    true
                } else if !is_ga_only && self.config.statsig_server_key.is_some() {
                    // Statsig already accepted this event; split GA conversion into its
                    // own outbox item so retries do not duplicate the Statsig event.
                    let mut ga_retry = delivery.event.clone();
                    ga_retry.id = format!("ga:{}", delivery.event.id);
                    store
                        .record_billing_analytics(&delivery.team_id, &[ga_retry])
                        .await
                        .is_ok()
                } else {
                    false
                };
                if !ga_ok {
                    tracing::warn!("billing GA conversion delivery failed; scheduled retry");
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

    async fn deliver_ga_conversion(
        &self,
        delivery: &BillingAnalyticsDelivery,
        attribution: &MarketingAttribution,
        endpoint: &str,
    ) -> bool {
        let (Some(measurement_id), Some(api_secret)) = (
            self.config.ga_measurement_id.as_deref(),
            self.config.ga_api_secret.as_deref(),
        ) else {
            return false;
        };
        let Some(body) = ga_conversion_body(delivery, attribution) else {
            return true;
        };
        let Ok(mut url) = url::Url::parse(endpoint) else {
            return false;
        };
        url.query_pairs_mut()
            .append_pair("measurement_id", measurement_id)
            .append_pair("api_secret", api_secret);
        let response = self
            .client
            .post(url)
            .timeout(Duration::from_secs(5))
            .json(&body)
            .send()
            .await;
        response.is_ok_and(|res| res.status().is_success())
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
        if invoice["status"] != "paid" {
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

fn major_currency_value(amount_minor: i64, currency: &str) -> f64 {
    match currency.to_ascii_uppercase().as_str() {
        "BIF" | "CLP" | "DJF" | "GNF" | "JPY" | "KMF" | "KRW" | "MGA" | "PYG" | "RWF" | "UGX"
        | "VND" | "VUV" | "XAF" | "XOF" | "XPF" => amount_minor as f64,
        "BHD" | "JOD" | "KWD" | "OMR" | "TND" => (amount_minor as f64) / 1000.0,
        _ => (amount_minor as f64) / 100.0,
    }
}

fn is_ga_conversion_candidate(fact: &BillingAnalyticsEvent) -> bool {
    fact.name == "billing_invoice_paid"
        && fact.metadata.get("billing_reason").map(String::as_str) == Some("subscription_create")
}

fn ga_conversion_body(
    delivery: &BillingAnalyticsDelivery,
    attribution: &MarketingAttribution,
) -> Option<Value> {
    let fact = &delivery.event;
    if !is_ga_conversion_candidate(fact) {
        return None;
    }
    let amount_minor = fact.value.filter(|value| *value >= 0)?;
    let currency = fact.metadata.get("currency")?.to_ascii_uppercase();
    let transaction_id = fact
        .id
        .strip_prefix("ga:")
        .unwrap_or(&fact.id)
        .strip_prefix("invoice:")?
        .strip_suffix(":paid")?;
    let client_id = attribution
        .ga_client_id
        .clone()
        .unwrap_or_else(|| format!("server.{}", delivery.team_id));
    let mut params = json!({
        "transaction_id": transaction_id,
        "value": major_currency_value(amount_minor, &currency),
        "currency": currency,
    });
    if let Some(obj) = params.as_object_mut() {
        if let Some(plan) = fact.metadata.get("plan") {
            obj.insert("plan".into(), json!(plan));
        }
        if let Some(interval) = fact.metadata.get("interval") {
            obj.insert("interval".into(), json!(interval));
        }
        for (key, value) in [
            ("gclid", attribution.gclid.as_ref()),
            ("gbraid", attribution.gbraid.as_ref()),
            ("wbraid", attribution.wbraid.as_ref()),
            ("campaign_source", attribution.utm_source.as_ref()),
            ("campaign_medium", attribution.utm_medium.as_ref()),
            ("campaign_name", attribution.utm_campaign.as_ref()),
            ("campaign_term", attribution.utm_term.as_ref()),
            ("campaign_content", attribution.utm_content.as_ref()),
        ] {
            if let Some(value) = value {
                obj.insert(key.into(), json!(value));
            }
        }
    }
    let mut body = json!({
        "client_id": client_id,
        "timestamp_micros": fact.time.saturating_mul(1000),
        "events": [{
            "name": "purchase",
            "params": params,
        }],
    });
    if let Some(user_id) = fact.user_id.as_ref() {
        body["user_id"] = json!(user_id);
    }
    Some(body)
}

#[cfg(test)]
mod tests;
