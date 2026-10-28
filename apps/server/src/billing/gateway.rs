use super::{BillingService, billing_error};
use crate::error::{ApiError, Result};
use reqwest::Method;
use serde_json::Value;

impl BillingService {
    pub(super) async fn stripe(
        &self,
        method: Method,
        path: &str,
        fields: Vec<(String, String)>,
        key: Option<&str>,
    ) -> Result<Value> {
        let secret =
            self.config.stripe_secret_key.as_deref().ok_or_else(|| {
                billing_error("payments_unavailable", "Payments are not configured")
            })?;
        let mut request = self
            .client
            .request(method.clone(), format!("{}/{path}", self.api_base))
            .bearer_auth(secret)
            .header("Stripe-Version", "2024-06-20");
        if method == Method::GET {
            request = request.query(&fields);
        } else {
            request = request.form(&fields);
        }
        if let Some(key) = key {
            request = request.header("Idempotency-Key", key);
        }
        let response = request.send().await.map_err(|_| {
            billing_error(
                "payment_provider_unavailable",
                "Stripe is temporarily unavailable",
            )
        })?;
        if !response.status().is_success() {
            return Err(
                if response.status() == reqwest::StatusCode::PAYMENT_REQUIRED {
                    billing_error(
                        "payment_required",
                        "Payment must complete before the plan changes",
                    )
                } else {
                    billing_error(
                        "payment_provider_unavailable",
                        "Stripe could not complete this request",
                    )
                },
            );
        }
        response.json().await.map_err(|_| ApiError::internal())
    }

    pub(super) async fn approved_price(&self, plan: &str, interval: &str) -> Result<Value> {
        let price = self.configured_price(plan, interval).await?;
        if price["active"] != true {
            return Err(billing_error(
                "offer_unavailable",
                "This offer is no longer available for purchase",
            ));
        }
        Ok(price)
    }

    pub(super) async fn configured_price(&self, plan: &str, interval: &str) -> Result<Value> {
        let id = self
            .config
            .price(plan, interval)
            .ok_or_else(|| ApiError::bad("unknown subscription plan or interval"))?;
        let price = self
            .stripe(Method::GET, &format!("prices/{id}"), vec![], None)
            .await?;
        let expected_interval = match interval {
            "month" | "year" => interval,
            _ => {
                return Err(ApiError::bad("interval must be month or year"));
            }
        };
        if price["id"] != id
            || price["type"] != "recurring"
            || price["recurring"]["interval"] != expected_interval
            || price["recurring"]["interval_count"] != 1
            || !price["unit_amount"].as_i64().is_some_and(|v| v > 0)
            || price["currency"].as_str().is_none()
            || stripe_id(&price["product"]).is_none()
        {
            return Err(billing_error(
                "invalid_price_configuration",
                "The configured offer is not a matching subscription Price",
            ));
        }
        Ok(price)
    }
}

pub(super) fn stripe_id(value: &Value) -> Option<&str> {
    value.as_str().or_else(|| value["id"].as_str())
}
pub(super) fn hosted_url(value: &Value) -> Result<String> {
    let raw = value["url"].as_str().ok_or_else(ApiError::internal)?;
    let url = url::Url::parse(raw).map_err(|_| ApiError::internal())?;
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some("checkout.stripe.com" | "billing.stripe.com")
        )
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ApiError::internal());
    }
    Ok(raw.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn payment_destinations_remain_stripe_owned_https() {
        assert!(hosted_url(&json!({"url":"https://checkout.stripe.com/c/pay/x"})).is_ok());
        for url in [
            "http://checkout.stripe.com/x",
            "https://evil.example/x",
            "https://user@checkout.stripe.com/x",
        ] {
            assert!(hosted_url(&json!({"url":url})).is_err());
        }
    }
}
