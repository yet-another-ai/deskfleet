//! Stripe-hosted checkout and local, payment-verified Team entitlements.
mod analytics;
mod config;
mod gateway;
mod handlers;
mod portal;
mod reconcile;
#[cfg(test)]
mod tests;
mod webhook;
mod worker;

pub use config::BillingConfig;
pub use handlers::configure;

use crate::error::{ApiError, Result};
use actix_web::http::StatusCode;
use deskfleet_control_store::{ControlStore, billing::CheckoutAttempt};
use gateway::{hosted_url, stripe_id};
use reqwest::Method;
use serde_json::Value;
use std::time::Duration;

#[derive(Clone)]
pub struct BillingService {
    config: BillingConfig,
    client: reqwest::Client,
    web_url: String,
    api_base: String,
}
pub struct BillingWorker([tokio::task::JoinHandle<()>; 3]);
struct BillingActor<'a> {
    team: &'a str,
    user: &'a str,
}
impl Drop for BillingWorker {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

pub(super) fn billing_error(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, code, message)
}

impl BillingService {
    pub fn new(config: BillingConfig, web_url: String) -> Result<Self> {
        config
            .validate()
            .map_err(|e| ApiError::bad(e.to_string()))?;
        let url = url::Url::parse(&web_url)
            .map_err(|_| ApiError::bad("invalid billing return origin"))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(ApiError::bad("invalid billing return origin"));
        }
        Ok(Self {
            config,
            web_url: web_url.trim_end_matches('/').into(),
            api_base: "https://api.stripe.com/v1".into(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| ApiError::internal())?,
        })
    }
    pub fn enabled(&self) -> bool {
        self.config.enabled()
    }
    pub fn enterprise_contact_email(&self) -> Option<&str> {
        self.config.enterprise_contact_email.as_deref()
    }
    fn return_url(&self, team: &str, outcome: &str) -> String {
        format!(
            "{}/?team={team}&settings=plans&billing_return={outcome}",
            self.web_url
        )
    }
    fn require_enabled(&self) -> Result<()> {
        if self.enabled() {
            Ok(())
        } else {
            Err(billing_error(
                "payments_unavailable",
                "Payments are not configured for this installation",
            ))
        }
    }
    pub async fn checkout(
        &self,
        store: &ControlStore,
        team: &str,
        actor: &str,
        plan: &str,
        interval: &str,
        request_id: &str,
    ) -> Result<String> {
        self.require_enabled()?;
        deskfleet_control_store::billing::Plan::paid(plan)?;
        if !matches!(interval, "month" | "year") {
            return Err(ApiError::bad("interval must be month or year"));
        }
        uuid::Uuid::parse_str(request_id).map_err(|_| ApiError::bad("requestId must be a UUID"))?;
        let lease = store.claim_billing_operation(team).await?.ok_or_else(|| {
            ApiError::new(
                StatusCode::CONFLICT,
                "billing_busy",
                "Another billing operation is in progress",
            )
        })?;
        let result = self
            .checkout_locked(
                store,
                BillingActor { team, user: actor },
                plan,
                interval,
                request_id,
                &lease,
            )
            .await;
        store.release_billing_operation(team, &lease).await?;
        result
    }
    async fn checkout_locked(
        &self,
        store: &ControlStore,
        actor: BillingActor<'_>,
        plan: &str,
        interval: &str,
        request_id: &str,
        lease: &str,
    ) -> Result<String> {
        let BillingActor { team, user: actor } = actor;
        let profile = store.billing_profile(team).await?;
        if profile
            .paid_through
            .is_some_and(|end| end > deskfleet_control_store::now_ms())
            || (profile.subscription_id.is_some()
                && !matches!(
                    profile.subscription_status.as_deref(),
                    Some("canceled" | "incomplete_expired")
                ))
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "subscription_exists",
                "Manage the existing subscription in billing",
            ));
        }
        let price = self.approved_price(plan, interval).await?;
        if let Some(attempt) = store.checkout_attempt(request_id).await? {
            if attempt.team_id != team
                || attempt.plan != plan
                || attempt.billing_interval != interval
            {
                return Err(ApiError::bad("requestId belongs to a different checkout"));
            }
            if !matches!(attempt.status.as_str(), "pending" | "open") {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "checkout_finished",
                    "Start a new checkout request",
                ));
            }
            return self
                .complete_checkout(store, team, lease, &attempt, &price)
                .await;
        }
        if let Some(mut old) = store.open_checkout(team).await? {
            if old.session_id.is_none() {
                let old_price = self
                    .approved_price(&old.plan, &old.billing_interval)
                    .await?;
                self.complete_checkout(store, team, lease, &old, &old_price)
                    .await?;
                old = store
                    .checkout_attempt(&old.request_id)
                    .await?
                    .ok_or_else(ApiError::internal)?;
            }
            let session_id = old.session_id.as_deref().ok_or_else(ApiError::internal)?;
            let session = self
                .stripe(
                    Method::GET,
                    &format!("checkout/sessions/{session_id}"),
                    vec![],
                    None,
                )
                .await?;
            if session["status"] == "complete" {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "checkout_pending",
                    "Payment is being synchronized",
                ));
            }
            if session["status"] == "open" {
                self.stripe(
                    Method::POST,
                    &format!("checkout/sessions/{session_id}/expire"),
                    vec![],
                    Some(&format!("expire-{session_id}")),
                )
                .await?;
            } else if session["status"] != "expired" {
                return Err(ApiError::internal());
            }
            store
                .update_checkout_attempt(team, lease, &old.request_id, session_id, "expired", &[])
                .await?;
        }
        let attempt = store
            .create_checkout_attempt(team, lease, request_id, plan, interval, actor)
            .await?;
        self.complete_checkout(store, team, lease, &attempt, &price)
            .await
    }
    async fn complete_checkout(
        &self,
        store: &ControlStore,
        team: &str,
        lease: &str,
        attempt: &CheckoutAttempt,
        price: &Value,
    ) -> Result<String> {
        if let Some(id) = attempt.session_id.as_deref() {
            let existing = self
                .stripe(
                    Method::GET,
                    &format!("checkout/sessions/{id}"),
                    vec![],
                    None,
                )
                .await?;
            if existing["status"] != "open" {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "checkout_finished",
                    "This checkout has completed or expired",
                ));
            }
            let url = hosted_url(&existing)?;
            let events: Vec<_> = self.checkout_analytics(attempt).into_iter().collect();
            store
                .update_checkout_attempt(team, lease, &attempt.request_id, id, "open", &events)
                .await?;
            return Ok(url);
        }
        let profile = store.billing_profile(team).await?;
        let customer = match profile.customer_id {
            Some(id) => id,
            None => {
                let value = self
                    .stripe(
                        Method::POST,
                        "customers",
                        vec![("metadata[deskfleet_team_id]".into(), team.into())],
                        Some(&format!("deskfleet-customer-{team}")),
                    )
                    .await?;
                let id = stripe_id(&value).ok_or_else(ApiError::internal)?.to_owned();
                store.billing_customer(team, lease, &id).await?;
                id
            }
        };
        let params = vec![
            ("mode".into(), "subscription".into()),
            ("customer".into(), customer),
            (
                "line_items[0][price]".into(),
                stripe_id(price).ok_or_else(ApiError::internal)?.into(),
            ),
            ("line_items[0][quantity]".into(), "1".into()),
            (
                "success_url".into(),
                self.return_url(team, "checkout_success"),
            ),
            (
                "cancel_url".into(),
                self.return_url(team, "checkout_cancel"),
            ),
            ("client_reference_id".into(), team.into()),
            (
                "subscription_data[billing_mode][type]".into(),
                "flexible".into(),
            ),
            ("metadata[deskfleet_team_id]".into(), team.into()),
            (
                "metadata[deskfleet_request_id]".into(),
                attempt.request_id.clone(),
            ),
            (
                "subscription_data[metadata][deskfleet_team_id]".into(),
                team.into(),
            ),
            (
                "subscription_data[metadata][deskfleet_request_id]".into(),
                attempt.request_id.clone(),
            ),
        ];
        let session = self
            .stripe(
                Method::POST,
                "checkout/sessions",
                params,
                Some(&format!("deskfleet-checkout-{}", attempt.request_id)),
            )
            .await?;
        let url = hosted_url(&session)?;
        let id = stripe_id(&session).ok_or_else(ApiError::internal)?;
        let events: Vec<_> = self.checkout_analytics(attempt).into_iter().collect();
        store
            .update_checkout_attempt(team, lease, &attempt.request_id, id, "open", &events)
            .await?;
        Ok(url)
    }
}
