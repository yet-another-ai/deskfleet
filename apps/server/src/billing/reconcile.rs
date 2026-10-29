use super::{BillingService, billing_error, gateway::stripe_id};
use crate::error::{ApiError, Result};
use deskfleet_control_store::{
    ControlStore,
    billing::{BillingProfile, PaymentEvent, SubscriptionProjection},
};
use reqwest::Method;
use serde_json::Value;

impl BillingService {
    pub(super) async fn process_event(
        &self,
        store: &ControlStore,
        event: &PaymentEvent,
    ) -> Result<()> {
        let object = if event.event_type.starts_with("checkout.") {
            self.stripe(
                Method::GET,
                &format!("checkout/sessions/{}", event.object_id),
                vec![],
                None,
            )
            .await?
        } else if event.event_type.starts_with("invoice.") {
            self.stripe(
                Method::GET,
                &format!("invoices/{}", event.object_id),
                vec![],
                None,
            )
            .await?
        } else {
            self.stripe(
                Method::GET,
                &format!("subscriptions/{}", event.object_id),
                vec![],
                None,
            )
            .await?
        };
        let customer = stripe_id(&object["customer"]).ok_or_else(ApiError::internal)?;
        let profile = store.billing_profile_by_customer(customer).await?;
        // Commit verified coverage before any extra historical analytics reads.
        // A later analytics failure keeps this inbox event retryable.
        self.reconcile_team(store, &profile.team_id).await?;
        if self.config.statsig_server_key.is_some() && event.event_type.starts_with("invoice.") {
            let subscription_id =
                stripe_id(&object["parent"]["subscription_details"]["subscription"]);
            if let Some(id) = subscription_id {
                let subscription = self
                    .stripe(Method::GET, &format!("subscriptions/{id}"), vec![], None)
                    .await?;
                if let Some(fact) = self
                    .invoice_analytics(store, &profile, &subscription, &object, Some(event), None)
                    .await?
                {
                    store
                        .record_billing_analytics(&profile.team_id, &[fact])
                        .await?;
                }
            }
        }
        Ok(())
    }

    pub(super) async fn reconcile_team(&self, store: &ControlStore, team: &str) -> Result<()> {
        let Some(lease) = store.claim_billing_operation(team).await? else {
            return Err(billing_error(
                "billing_busy",
                "Billing synchronization is in progress",
            ));
        };
        self.reconcile_claimed(store, team, &lease).await
    }

    pub(super) async fn reconcile_claimed(
        &self,
        store: &ControlStore,
        team: &str,
        lease: &str,
    ) -> Result<()> {
        let result = self.reconcile_locked(store, team, lease).await;
        store
            .finish_billing_reconciliation(team, lease, result.is_ok())
            .await?;
        result
    }
    async fn reconcile_locked(&self, store: &ControlStore, team: &str, lease: &str) -> Result<()> {
        let profile = store.billing_profile(team).await?;
        let Some(customer) = profile.customer_id.as_deref() else {
            return Ok(());
        };
        let mut subscription = profile.subscription_id.clone();
        let mut completed = None;
        if let Some(attempt) = store.open_checkout(team).await?
            && let Some(session_id) = attempt.session_id.as_deref()
        {
            let session = self
                .stripe(
                    Method::GET,
                    &format!("checkout/sessions/{session_id}"),
                    vec![],
                    None,
                )
                .await?;
            if stripe_id(&session["customer"]) != Some(customer)
                || session["metadata"]["deskfleet_team_id"] != team
            {
                return Err(ApiError::internal());
            }
            if session["status"] == "complete" {
                subscription = stripe_id(&session["subscription"]).map(str::to_owned);
                completed = Some((attempt.request_id, session_id.to_owned()));
            } else if session["status"] == "expired" {
                store
                    .update_checkout_attempt(
                        team,
                        lease,
                        &attempt.request_id,
                        session_id,
                        "expired",
                        &[],
                    )
                    .await?;
            }
        }
        if completed.is_none() {
            // Repairs payment completion even if saving the Checkout Session ID
            // failed. Provider objects are read before any paid authority is added.
            let list = self
                .stripe(
                    Method::GET,
                    "subscriptions",
                    vec![
                        ("customer".into(), customer.into()),
                        ("status".into(), "all".into()),
                        ("limit".into(), "100".into()),
                    ],
                    None,
                )
                .await?;
            let owned: Vec<&Value> = list["data"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|s| {
                    s["metadata"]["deskfleet_team_id"] == team
                        && !matches!(
                            s["status"].as_str(),
                            Some("canceled" | "incomplete_expired")
                        )
                })
                .collect();
            if owned.len() > 1 || list["has_more"] == true {
                return Err(billing_error(
                    "billing_reconciliation_required",
                    "The billing account needs reconciliation",
                ));
            }
            if let Some(id) = owned.first().and_then(|s| stripe_id(s)) {
                subscription = Some(id.to_owned());
            }
        }
        if let Some(id) = subscription {
            let subscription = self
                .stripe(
                    Method::GET,
                    &format!("subscriptions/{id}"),
                    vec![("expand[]".into(), "latest_invoice".into())],
                    None,
                )
                .await?;
            let price_id = subscription["items"]["data"]
                .as_array()
                .filter(|v| v.len() == 1)
                .and_then(|v| stripe_id(&v[0]["price"]))
                .ok_or_else(ApiError::internal)?;
            let plan = self.config.plan_for_price(price_id).ok_or_else(|| {
                billing_error(
                    "unknown_subscription_price",
                    "The subscription price is not configured",
                )
            })?;
            let interval = self.config.interval_for_price(price_id).ok_or_else(|| {
                billing_error(
                    "unknown_subscription_price",
                    "The subscription price is not configured",
                )
            })?;
            let price = self.configured_price(plan, interval).await?;
            let mut invoice = subscription["latest_invoice"].clone();
            if let Some(id) = invoice.as_str() {
                invoice = self
                    .stripe(Method::GET, &format!("invoices/{id}"), vec![], None)
                    .await?;
            }
            let projection = verified_projection(&profile, &subscription, &invoice, &price, plan)?;
            let mut events = self
                .subscription_analytics(store, &profile, &subscription, &projection)
                .await?;
            if let Some(fact) = self
                .invoice_analytics(store, &profile, &subscription, &invoice, None, Some(&price))
                .await?
            {
                events.push(fact);
            }
            // Completion also repairs a provider-created Checkout whose atomic
            // session/outbox transaction never committed locally.
            if let Some(request) = subscription["metadata"]["deskfleet_request_id"].as_str()
                && let Some(attempt) = store.checkout_attempt(request).await?
                && attempt.team_id == team
                && let Some(fact) = self.checkout_analytics(&attempt)
            {
                events.push(fact);
            }
            store
                .apply_subscription(team, lease, &projection, &events)
                .await?;
            if let Some(request) = subscription["metadata"]["deskfleet_request_id"].as_str() {
                store
                    .complete_checkout_request(team, lease, request)
                    .await?;
            }
            if let Some((request, session)) = completed {
                store
                    .update_checkout_attempt(team, lease, &request, &session, "complete", &[])
                    .await?;
            }
        }
        Ok(())
    }
}

/// Subscription status is descriptive. Only a paid invoice for the configured
/// current Price and billing period can establish or extend paid coverage.
fn verified_projection(
    profile: &BillingProfile,
    subscription: &Value,
    invoice: &Value,
    price: &Value,
    plan: &str,
) -> Result<SubscriptionProjection> {
    let id = stripe_id(subscription).ok_or_else(ApiError::internal)?;
    let customer = profile
        .customer_id
        .as_deref()
        .ok_or_else(ApiError::internal)?;
    let item = &subscription["items"]["data"][0];
    if stripe_id(&subscription["customer"]) != Some(customer)
        || subscription["metadata"]["deskfleet_team_id"] != profile.team_id
        || item["quantity"] != 1
        || stripe_id(&item["price"]) != stripe_id(price)
    {
        return Err(billing_error(
            "invalid_subscription",
            "Subscription ownership or price does not match",
        ));
    }
    let end = item["current_period_end"]
        .as_i64()
        .ok_or_else(ApiError::internal)?;
    let anchor = subscription["billing_cycle_anchor"]
        .as_i64()
        .ok_or_else(ApiError::internal)?;
    let status = subscription["status"]
        .as_str()
        .ok_or_else(ApiError::internal)?;
    let invoice_subscription =
        stripe_id(&invoice["parent"]["subscription_details"]["subscription"]);
    let paid = status != "trialing"
        && invoice["status"] == "paid"
        && invoice_subscription == Some(id)
        && stripe_id(&invoice["customer"]) == Some(customer)
        && invoice["currency"] == price["currency"]
        && invoice["lines"]["has_more"] != true
        && invoice["lines"]["data"].as_array().is_some_and(|lines| {
            lines.iter().any(|line| {
                let line_price = stripe_id(&line["pricing"]["price_details"]["price"]);
                line_price == stripe_id(price)
                    && line["period"]["end"].as_i64() == Some(end)
                    && line["amount"].as_i64().is_some_and(|amount| amount >= 0)
            })
        });
    // An unpaid update keeps the previous plan and paid-through instant. This also
    // prevents an externally changed subscription from granting unpaid upgrades.
    Ok(SubscriptionProjection {
        subscription_id: id.into(),
        status: status.into(),
        paid_plan: paid.then(|| plan.into()),
        paid_through: if paid {
            Some(end.checked_mul(1000).ok_or_else(ApiError::internal)?)
        } else {
            None
        },
        period_anchor: anchor.checked_mul(1000).ok_or_else(ApiError::internal)?,
        // Flexible-mode Portal cancellation uses cancel_at, while Stripe's
        // cancel_at_period_end boolean stays false.
        cancel_at_period_end: subscription["cancel_at"].as_i64().is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn data() -> (BillingProfile, Value, Value, Value) {
        let profile = BillingProfile {
            team_id: "1".into(),
            customer_id: Some("cus".into()),
            subscription_id: Some("sub".into()),
            plan: Some("go".into()),
            subscription_status: Some("active".into()),
            paid_through: Some(1000),
            period_anchor: 0,
            cancel_at_period_end: false,
            enterprise: false,
        };
        let subscription = json!({
            "id":"sub","customer":"cus","metadata":{"deskfleet_team_id":"1"},
            "items":{"data":[{"quantity":1,"price":{"id":"price_pro"},"current_period_end":2000}]},
            "billing_mode":{"type":"flexible"},
            "billing_cycle_anchor":100,"status":"active","cancel_at":null
        });
        let invoice = json!({
            "id":"in","customer":"cus","status":"paid","currency":"usd",
            "parent":{"type":"subscription_details","subscription_details":{"subscription":"sub"}},
            "lines":{"data":[{
                "pricing":{"type":"price_details","price_details":{"price":"price_pro"}},
                "period":{"end":2000},"amount":1000
            }]}
        });
        (
            profile,
            subscription,
            invoice,
            json!({"id":"price_pro","currency":"usd"}),
        )
    }
    #[test]
    fn active_subscription_does_not_prove_payment() {
        let (p, s, mut i, price) = data();
        i["status"] = json!("open");
        let result = verified_projection(&p, &s, &i, &price, "pro").unwrap();
        assert!(result.paid_plan.is_none());
        assert!(result.paid_through.is_none());
    }
    #[test]
    fn paid_invoice_proves_exact_plan_and_coverage() {
        let (p, s, i, price) = data();
        let result = verified_projection(&p, &s, &i, &price, "pro").unwrap();
        assert_eq!(result.paid_plan.as_deref(), Some("pro"));
        assert_eq!(result.paid_through, Some(2_000_000));
    }
    #[test]
    fn flexible_portal_cancellation_tracks_the_cancel_at_timestamp() {
        let (p, mut s, i, price) = data();
        s["cancel_at_period_end"] = json!(false);
        s["cancel_at"] = json!(2000);
        let scheduled = verified_projection(&p, &s, &i, &price, "pro").unwrap();
        assert!(scheduled.cancel_at_period_end);
        assert_eq!(scheduled.paid_through, Some(2_000_000));
        s["cancel_at"] = Value::Null;
        assert!(
            !verified_projection(&p, &s, &i, &price, "pro")
                .unwrap()
                .cancel_at_period_end
        );
    }
    #[test]
    fn paid_credit_invoice_applies_immediate_downgrade_without_a_cash_payment() {
        let (mut profile, mut subscription, mut invoice, mut price) = data();
        profile.plan = Some("pro".into());
        subscription["items"]["data"][0]["price"]["id"] = json!("price_go");
        price["id"] = json!("price_go");
        invoice["amount_paid"] = json!(0);
        invoice["amount_due"] = json!(0);
        for debit in [0, 250, 750] {
            invoice["total"] = json!(-750 + debit);
            invoice["lines"]["data"] = json!([
                {"pricing":{"type":"price_details","price_details":{"price":"price_pro"}},"period":{"end":2000},"amount":-750},
                {"pricing":{"type":"price_details","price_details":{"price":"price_go"}},"period":{"end":2000},"amount":debit}
            ]);
            let result =
                verified_projection(&profile, &subscription, &invoice, &price, "go").unwrap();
            assert_eq!(result.paid_plan.as_deref(), Some("go"));
            assert_eq!(result.paid_through, Some(2_000_000));
        }
    }
    #[test]
    fn a_credit_for_the_current_price_alone_does_not_establish_paid_coverage() {
        let (profile, subscription, mut invoice, price) = data();
        invoice["lines"]["data"][0]["amount"] = json!(-1000);
        let result = verified_projection(&profile, &subscription, &invoice, &price, "pro").unwrap();
        assert!(result.paid_plan.is_none());
        assert!(result.paid_through.is_none());
    }
    #[test]
    fn old_price_or_wrong_customer_cannot_grant_upgrade() {
        let (p, s, mut i, price) = data();
        i["lines"]["data"][0]["pricing"]["price_details"]["price"] = json!("price_go");
        assert!(
            verified_projection(&p, &s, &i, &price, "pro")
                .unwrap()
                .paid_plan
                .is_none()
        );
        i["customer"] = json!("other");
        assert!(
            verified_projection(&p, &s, &i, &price, "pro")
                .unwrap()
                .paid_plan
                .is_none()
        );
    }
}
