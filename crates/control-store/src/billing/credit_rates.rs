//! Site-wide conversion of model usage to Team credits.
use crate::entities::{
    cp_cloud_credit_rates as rates, cp_site_admins as admins, cp_site_audit as audit,
};
use crate::policies::{SiteAction, SitePolicy, authorize};
use crate::{ControlStore, Error, Result, now_ms};
use sea_orm::prelude::BigDecimal;
use sea_orm::{ActiveModelTrait, EntityTrait, QuerySelect, Set, TransactionTrait, Unchanged};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Exact, nonnegative credits per token. Decimal strings round trip through web clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "String", into = "String")]
pub struct CreditRate(BigDecimal);

impl TryFrom<String> for CreditRate {
    type Error = &'static str;

    fn try_from(text: String) -> std::result::Result<Self, Self::Error> {
        const INVALID: &str = "credit rates require a nonnegative decimal string with up to 12 integer and 6 fractional digits";
        let (whole, fraction) = text
            .split_once('.')
            .map_or((text.as_str(), None), |(w, f)| (w, Some(f)));
        if !(1..=12).contains(&whole.len())
            || !whole.bytes().all(|c| c.is_ascii_digit())
            || fraction.is_some_and(|f| {
                !(1..=6).contains(&f.len()) || !f.bytes().all(|c| c.is_ascii_digit())
            })
        {
            return Err(INVALID);
        }
        Ok(Self(text.parse().map_err(|_| INVALID)?))
    }
}

impl From<CreditRate> for String {
    fn from(rate: CreditRate) -> Self {
        rate.0.normalized().to_plain_string()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreditRates {
    pub input: CreditRate,
    pub output: CreditRate,
    pub cache_read: CreditRate,
    pub cache_write: CreditRate,
}

impl From<rates::Model> for CreditRates {
    fn from(row: rates::Model) -> Self {
        Self {
            input: CreditRate(row.input),
            output: CreditRate(row.output),
            cache_read: CreditRate(row.cache_read),
            cache_write: CreditRate(row.cache_write),
        }
    }
}

impl ControlStore {
    pub async fn admin_credit_rates(&self, actor_id: &str) -> Result<CreditRates> {
        authorize(
            &SitePolicy::new(self.is_site_admin(actor_id).await?),
            SiteAction::ReadSettings,
        )?;
        Ok(rates::Entity::find_by_id(true)
            .one(&self.db)
            .await?
            .ok_or(Error::NotFound)?
            .into())
    }

    pub async fn update_credit_rates(
        &self,
        actor_id: &str,
        rates: CreditRates,
    ) -> Result<CreditRates> {
        let tx = self.db.begin().await?;
        let granted = admins::Entity::find_by_id(actor_id)
            .lock_shared()
            .one(&tx)
            .await?
            .is_some();
        authorize(&SitePolicy::new(granted), SiteAction::UpdateSettings)?;

        let before = CreditRates::from(
            rates::Entity::find_by_id(true)
                .lock_exclusive()
                .one(&tx)
                .await?
                .ok_or(Error::NotFound)?,
        );
        if before != rates {
            rates::ActiveModel {
                singleton: Unchanged(true),
                input: Set(rates.input.0.clone()),
                output: Set(rates.output.0.clone()),
                cache_read: Set(rates.cache_read.0.clone()),
                cache_write: Set(rates.cache_write.0.clone()),
            }
            .update(&tx)
            .await?;
            audit::Entity::insert(audit::ActiveModel {
                actor_user_id: Set(Some(actor_id.into())),
                source: Set("user".into()),
                action: Set("settings.update".into()),
                before_value: Set(json!({"creditRates": before})),
                after_value: Set(json!({"creditRates": rates})),
                occurred_at: Set(now_ms()),
                ..Default::default()
            })
            .exec_without_returning(&tx)
            .await?;
        }
        tx.commit().await?;
        Ok(rates)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credit_rate_strings_are_exact_and_normalized() {
        for (value, normalized) in [
            ("0.000000", "0"),
            ("0.000001", "0.000001"),
            ("10.10", "10.1"),
            ("999999999999.999999", "999999999999.999999"),
        ] {
            let rate = serde_json::from_value::<CreditRate>(json!(value)).unwrap();
            assert_eq!(serde_json::to_value(rate).unwrap(), normalized);
        }
        for value in [
            json!("1234567890123"),
            json!("0.0000001"),
            json!("-1"),
            json!("1e2"),
            json!(1),
            json!("1."),
        ] {
            assert!(serde_json::from_value::<CreditRate>(value).is_err());
        }
    }
}
