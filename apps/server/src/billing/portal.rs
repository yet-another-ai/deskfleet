use super::{
    BillingService, billing_error,
    gateway::{hosted_url, stripe_id},
};
use crate::error::{ApiError, Result};
use deskfleet_control_store::ControlStore;
use reqwest::Method;
use serde_json::Value;

impl BillingService {
    pub async fn portal(&self, store: &ControlStore, team: &str, actor: &str) -> Result<String> {
        self.require_enabled()?;
        let profile = store.billing_profile(team).await?;
        let customer = profile
            .customer_id
            .as_deref()
            .ok_or_else(|| ApiError::bad("This Team has no billing account"))?;
        let configuration = self
            .config
            .portal_configuration_id
            .as_deref()
            .ok_or_else(ApiError::internal)?;
        self.validate_portal(configuration).await?;
        let session = self
            .stripe(
                Method::POST,
                "billing_portal/sessions",
                vec![
                    ("customer".into(), customer.into()),
                    ("configuration".into(), configuration.into()),
                    ("return_url".into(), self.return_url(team, "portal")),
                ],
                None,
            )
            .await?;
        let url = hosted_url(&session)?;
        self.record_portal(store, team, actor, &session).await?;
        Ok(url)
    }

    async fn validate_portal(&self, id: &str) -> Result<()> {
        let config = self
            .stripe(
                Method::GET,
                &format!("billing_portal/configurations/{id}"),
                vec![],
                None,
            )
            .await?;
        let (go_month, pro_month, go_year, pro_year) = tokio::try_join!(
            self.approved_price("go", "month"),
            self.approved_price("pro", "month"),
            self.approved_price("go", "year"),
            self.approved_price("pro", "year"),
        )?;
        if portal_valid(&config, &[go_month, pro_month, go_year, pro_year]) {
            Ok(())
        } else {
            Err(billing_error(
                "invalid_portal_configuration",
                "Billing Portal must offer the four configured Prices on separate Go/Pro Products, invoice prorated changes immediately, and cancel at period end",
            ))
        }
    }
}

/// One Portal exposes both intervals for each plan. Stripe permits one Price per
/// Product and interval, so Go and Pro must use separate Products.
fn portal_valid(config: &Value, prices: &[Value; 4]) -> bool {
    let [go_month, pro_month, go_year, pro_year] = prices;
    let updates = &config["features"]["subscription_update"];
    let allowed = updates["default_allowed_updates"]
        .as_array()
        .is_some_and(|items| items.len() == 1 && items[0] == "price");
    let immediate = updates["schedule_at_period_end"]["conditions"]
        .as_array()
        .is_some_and(Vec::is_empty);
    let catalog_matches = updates["products"].as_array().is_some_and(|products| {
        products.len() == 2
            && [(go_month, go_year), (pro_month, pro_year)]
                .iter()
                .all(|(month, year)| {
                    products
                        .iter()
                        .any(|product| product_matches(product, month, year))
                })
    });
    config["active"] == true
        && updates["enabled"] == true
        && allowed
        && updates["proration_behavior"] == "always_invoice"
        && immediate
        && config["features"]["subscription_cancel"]["enabled"] == true
        && config["features"]["subscription_cancel"]["mode"] == "at_period_end"
        && config["features"]["invoice_history"]["enabled"] == true
        && config["features"]["payment_method_update"]["enabled"] == true
        && prices
            .iter()
            .all(|price| price["currency"] == go_month["currency"])
        && stripe_id(&go_month["product"]) != stripe_id(&pro_month["product"])
        && [(go_month, pro_month), (go_year, pro_year)]
            .iter()
            .all(|(go, pro)| {
                go["unit_amount"]
                    .as_i64()
                    .zip(pro["unit_amount"].as_i64())
                    .is_some_and(|(go, pro)| go < pro)
            })
        && catalog_matches
}

fn product_matches(product: &Value, month: &Value, year: &Value) -> bool {
    let (Some(product_id), Some(month_id), Some(year_id)) = (
        stripe_id(&month["product"]),
        stripe_id(month),
        stripe_id(year),
    ) else {
        return false;
    };
    stripe_id(&year["product"]) == Some(product_id)
        && stripe_id(&product["product"]) == Some(product_id)
        && product["prices"].as_array().is_some_and(|ids| {
            ids.len() == 2
                && ids.iter().any(|id| id.as_str() == Some(month_id))
                && ids.iter().any(|id| id.as_str() == Some(year_id))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn prices() -> [Value; 4] {
        [
            json!({"id":"price_go","currency":"usd","product":"prod_go","unit_amount":500}),
            json!({"id":"price_pro","currency":"usd","product":"prod_pro","unit_amount":1500}),
            json!({"id":"price_go_year","currency":"usd","product":"prod_go","unit_amount":5000}),
            json!({"id":"price_pro_year","currency":"usd","product":"prod_pro","unit_amount":15000}),
        ]
    }

    fn portal_config() -> Value {
        json!({
            "active": true,
            "features": {
                "subscription_update": {
                    "enabled": true,
                    "default_allowed_updates": ["price"],
                    "proration_behavior": "always_invoice",
                    "schedule_at_period_end": {"conditions":[]},
                    "products": [
                        {"product":"prod_go","prices":["price_go","price_go_year"]},
                        {"product":"prod_pro","prices":["price_pro","price_pro_year"]}
                    ]
                },
                "subscription_cancel": {"enabled": true, "mode": "at_period_end"},
                "invoice_history": {"enabled": true},
                "payment_method_update": {"enabled": true}
            }
        })
    }

    #[test]
    fn one_portal_accepts_two_products_with_monthly_and_yearly_prices() {
        let mut config = portal_config();
        assert!(portal_valid(&config, &prices()));
        config["features"]["subscription_update"]["products"]
            .as_array_mut()
            .unwrap()
            .reverse();
        assert!(portal_valid(&config, &prices()));
    }

    #[test]
    fn portal_rejects_same_product_for_different_plans() {
        let mut catalog = prices();
        catalog[1]["product"] = json!("prod_go");
        catalog[3]["product"] = json!("prod_go");
        let mut config = portal_config();
        config["features"]["subscription_update"]["products"][1]["product"] = json!("prod_go");
        assert!(!portal_valid(&config, &catalog));
    }

    #[test]
    fn portal_requires_exact_prices_under_their_plan_product() {
        for ids in [
            json!(["price_go"]),
            json!(["price_go", "price_other"]),
            json!(["price_go", "price_go_year", "price_other"]),
        ] {
            let mut config = portal_config();
            config["features"]["subscription_update"]["products"][0]["prices"] = ids;
            assert!(!portal_valid(&config, &prices()));
        }
        let mut config = portal_config();
        config["features"]["subscription_update"]["products"][0]["product"] = json!("prod_other");
        assert!(!portal_valid(&config, &prices()));
        let mut catalog = prices();
        catalog[2]["product"] = json!("prod_other");
        assert!(!portal_valid(&portal_config(), &catalog));
    }

    #[test]
    fn portal_requires_immediate_prorated_invoices_for_all_switches() {
        for condition in ["decreasing_item_amount", "shortening_interval"] {
            let mut config = portal_config();
            config["features"]["subscription_update"]["schedule_at_period_end"] =
                json!({"conditions":[{"type":condition}]});
            assert!(!portal_valid(&config, &prices()));
        }
        for behavior in ["none", "create_prorations"] {
            let mut config = portal_config();
            config["features"]["subscription_update"]["proration_behavior"] = json!(behavior);
            assert!(!portal_valid(&config, &prices()));
        }
    }

    #[test]
    fn portal_requires_an_explicit_scheduling_policy_from_stripe() {
        for schedule in [Value::Null, json!({})] {
            let mut config = portal_config();
            config["features"]["subscription_update"]["schedule_at_period_end"] = schedule;
            assert!(!portal_valid(&config, &prices()));
        }
    }

    #[test]
    fn portal_preserves_currency_and_plan_price_ordering() {
        let mut catalog = prices();
        catalog[2]["currency"] = json!("eur");
        assert!(!portal_valid(&portal_config(), &catalog));
        let mut catalog = prices();
        catalog[3]["unit_amount"] = json!(1000);
        assert!(!portal_valid(&portal_config(), &catalog));
    }
}
