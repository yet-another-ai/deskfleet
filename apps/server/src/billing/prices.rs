use super::BillingService;
use crate::error::{ApiError, Result};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlanPrice {
    plan: String,
    interval: String,
    #[serde(rename(deserialize = "unit_amount", serialize = "unitAmount"))]
    unit_amount: i64,
    currency: String,
}

pub(super) type PriceCache = Option<(Instant, Vec<PlanPrice>)>;

impl BillingService {
    pub(super) async fn prices(&self) -> Result<Vec<PlanPrice>> {
        if !self.enabled() {
            return Ok(Vec::new());
        }
        // Share refreshes across requests; only the price catalog uses this async lock.
        let mut cache = self.price_cache.lock().await;
        if let Some((fetched, prices)) = cache.as_ref()
            && fetched.elapsed() < Duration::from_secs(300)
        {
            return Ok(prices.clone());
        }
        let (go, pro, go_year, pro_year) = tokio::try_join!(
            self.display_price("go", "month"),
            self.display_price("pro", "month"),
            self.display_price("go", "year"),
            self.display_price("pro", "year"),
        )?;
        let prices = vec![go, pro, go_year, pro_year];
        *cache = Some((Instant::now(), prices.clone()));
        Ok(prices)
    }

    async fn display_price(&self, plan: &str, interval: &str) -> Result<PlanPrice> {
        let mut price = self.approved_price(plan, interval).await?;
        price["plan"] = plan.into();
        price["interval"] = interval.into();
        serde_json::from_value(price).map_err(|_| ApiError::internal())
    }
}
