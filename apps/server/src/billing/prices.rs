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

pub(super) type PriceCache = Option<(Instant, Option<Vec<PlanPrice>>)>;

impl BillingService {
    pub(super) async fn prices(&self) -> Result<Option<Vec<PlanPrice>>> {
        if !self.enabled() {
            return Ok(Some(Vec::new()));
        }
        // Only the refreshing request waits for Stripe. Other Teams can read usage
        // immediately, with prices unavailable until the refresh completes.
        let Ok(mut cache) = self.price_cache.try_lock() else {
            return Ok(None);
        };
        if let Some((fetched, prices)) = cache.as_ref()
            && fetched.elapsed() < Duration::from_secs(if prices.is_some() { 300 } else { 30 })
        {
            return Ok(prices.clone());
        }
        let result = tokio::try_join!(
            self.display_price("go", "month"),
            self.display_price("pro", "month"),
            self.display_price("go", "year"),
            self.display_price("pro", "year"),
        );
        let (go, pro, go_year, pro_year) = match result {
            Ok(prices) => prices,
            Err(error) => {
                // Cache failure as well, so following requests do not each retry
                // the same unavailable provider. Cancellation still releases the lock.
                *cache = Some((Instant::now(), None));
                return Err(error);
            }
        };
        let prices = Some(vec![go, pro, go_year, pro_year]);
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
