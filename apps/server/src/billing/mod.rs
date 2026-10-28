//! Stripe-hosted checkout and local, payment-verified Team entitlements.
mod config;
mod gateway;
mod handlers;
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
pub struct BillingWorker([tokio::task::JoinHandle<()>; 2]);
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
    fn return_url(&self, team: &str) -> String {
        format!("{}/?team={team}&settings=plans", self.web_url)
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
        plan: &str,
        request_id: &str,
    ) -> Result<String> {
        self.require_enabled()?;
        deskfleet_control_store::billing::Plan::paid(plan)?;
        uuid::Uuid::parse_str(request_id).map_err(|_| ApiError::bad("requestId must be a UUID"))?;
        let lease = store.claim_billing_operation(team).await?.ok_or_else(|| {
            ApiError::new(
                StatusCode::CONFLICT,
                "billing_busy",
                "Another billing operation is in progress",
            )
        })?;
        let result = self
            .checkout_locked(store, team, plan, request_id, &lease)
            .await;
        store.release_billing_operation(team, &lease).await?;
        result
    }
    async fn checkout_locked(
        &self,
        store: &ControlStore,
        team: &str,
        plan: &str,
        request_id: &str,
        lease: &str,
    ) -> Result<String> {
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
        let price = self.approved_price(plan).await?;
        if let Some(attempt) = store.checkout_attempt(request_id).await? {
            if attempt.team_id != team || attempt.plan != plan {
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
                let old_price = self.approved_price(&old.plan).await?;
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
                .update_checkout_attempt(team, lease, &old.request_id, session_id, "expired")
                .await?;
        }
        let attempt = store
            .create_checkout_attempt(team, lease, request_id, plan)
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
            return hosted_url(&existing);
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
            ("success_url".into(), self.return_url(team)),
            ("cancel_url".into(), self.return_url(team)),
            ("client_reference_id".into(), team.into()),
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
        store
            .update_checkout_attempt(team, lease, &attempt.request_id, id, "open")
            .await?;
        Ok(url)
    }

    pub async fn portal(&self, store: &ControlStore, team: &str) -> Result<String> {
        self.require_enabled()?;
        let profile = store.billing_profile(team).await?;
        let customer = profile
            .customer_id
            .ok_or_else(|| ApiError::bad("This Team has no billing account"))?;
        self.validate_portal().await?;
        let configuration = self
            .config
            .portal_configuration_id
            .as_deref()
            .ok_or_else(ApiError::internal)?;
        let session = self
            .stripe(
                Method::POST,
                "billing_portal/sessions",
                vec![
                    ("customer".into(), customer),
                    ("configuration".into(), configuration.into()),
                    ("return_url".into(), self.return_url(team)),
                ],
                None,
            )
            .await?;
        hosted_url(&session)
    }

    async fn validate_portal(&self) -> Result<()> {
        let id = self
            .config
            .portal_configuration_id
            .as_deref()
            .ok_or_else(ApiError::internal)?;
        let config = self
            .stripe(
                Method::GET,
                &format!("billing_portal/configurations/{id}"),
                vec![],
                None,
            )
            .await?;
        let go = self.approved_price("go").await?;
        let pro = self.approved_price("pro").await?;
        let updates = &config["features"]["subscription_update"];
        let allowed = updates["default_allowed_updates"]
            .as_array()
            .is_some_and(|items| items.len() == 1 && items[0] == "price");
        let prices: Vec<&str> = updates["products"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|product| {
                product["prices"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
            })
            .collect();
        let scheduled = updates["schedule_at_period_end"]["conditions"]
            .as_array()
            .is_some_and(|conditions| {
                conditions
                    .iter()
                    .any(|c| c["type"] == "decreasing_item_amount")
            });
        let valid = config["active"] == true
            && updates["enabled"] == true
            && allowed
            && updates["proration_behavior"] == "always_invoice"
            && scheduled
            && config["features"]["subscription_cancel"]["enabled"] == true
            && config["features"]["subscription_cancel"]["mode"] == "at_period_end"
            && config["features"]["invoice_history"]["enabled"] == true
            && config["features"]["payment_method_update"]["enabled"] == true
            && go["currency"] == pro["currency"]
            && stripe_id(&go["product"]) == stripe_id(&pro["product"])
            && go["unit_amount"].as_i64() < pro["unit_amount"].as_i64()
            && prices.len() == 2
            && prices.contains(&stripe_id(&go).ok_or_else(ApiError::internal)?)
            && prices.contains(&stripe_id(&pro).ok_or_else(ApiError::internal)?);
        if valid {
            Ok(())
        } else {
            Err(billing_error(
                "invalid_portal_configuration",
                "Billing Portal must restrict changes to Go/Pro, invoice upgrades immediately, and schedule downgrades and cancellation at period end",
            ))
        }
    }
}
