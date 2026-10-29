use std::{env, io};

#[derive(Clone, Debug, Default)]
pub struct BillingConfig {
    pub hosted: bool,
    pub stripe_secret_key: Option<String>,
    pub stripe_webhook_secret: Option<String>,
    pub go_price_id: Option<String>,
    pub pro_price_id: Option<String>,
    pub go_yearly_price_id: Option<String>,
    pub pro_yearly_price_id: Option<String>,
    /// Portal configuration listing both monthly and yearly Go and Pro Prices.
    pub portal_configuration_id: Option<String>,
    /// Optional sales contact for Enterprise. Independent of Stripe configuration.
    pub enterprise_contact_email: Option<String>,
    /// Optional server-only Statsig key; payment processing never waits on Statsig.
    pub statsig_server_key: Option<String>,
    pub statsig_environment: Option<String>,
}
impl BillingConfig {
    pub fn from_env() -> io::Result<Self> {
        let hosted = match env::var("DESKFLEET_DEPLOYMENT_MODE").as_deref() {
            Err(env::VarError::NotPresent) | Ok("self-hosted") => false,
            Ok("hosted") => true,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "DESKFLEET_DEPLOYMENT_MODE must be self-hosted or hosted",
                ));
            }
        };
        let config = Self {
            hosted,
            stripe_secret_key: optional("DESKFLEET_STRIPE_SECRET_KEY"),
            stripe_webhook_secret: optional("DESKFLEET_STRIPE_WEBHOOK_SECRET"),
            go_price_id: optional("DESKFLEET_STRIPE_GO_PRICE_ID"),
            pro_price_id: optional("DESKFLEET_STRIPE_PRO_PRICE_ID"),
            go_yearly_price_id: optional("DESKFLEET_STRIPE_GO_YEARLY_PRICE_ID"),
            pro_yearly_price_id: optional("DESKFLEET_STRIPE_PRO_YEARLY_PRICE_ID"),
            portal_configuration_id: optional("DESKFLEET_STRIPE_PORTAL_CONFIGURATION_ID"),
            enterprise_contact_email: contact_email("DESKFLEET_ENTERPRISE_CONTACT_EMAIL")?,
            statsig_server_key: optional("DESKFLEET_STATSIG_SERVER_KEY"),
            statsig_environment: optional("DESKFLEET_STATSIG_ENVIRONMENT"),
        };
        config.validate()?;
        Ok(config)
    }
    pub fn enabled(&self) -> bool {
        self.hosted
            && self.stripe_secret_key.is_some()
            && self.stripe_webhook_secret.is_some()
            && self.go_price_id.is_some()
            && self.pro_price_id.is_some()
            && self.go_yearly_price_id.is_some()
            && self.pro_yearly_price_id.is_some()
            && self.portal_configuration_id.is_some()
    }
    pub fn validate(&self) -> io::Result<()> {
        let configured = [
            &self.stripe_secret_key,
            &self.stripe_webhook_secret,
            &self.go_price_id,
            &self.pro_price_id,
            &self.go_yearly_price_id,
            &self.pro_yearly_price_id,
            &self.portal_configuration_id,
        ]
        .iter()
        .filter(|value| value.is_some())
        .count();
        if configured > 0 && (!self.hosted || configured != 7) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Stripe requires hosted mode and all seven Stripe settings",
            ));
        }
        let prices = [
            self.go_price_id.as_deref(),
            self.pro_price_id.as_deref(),
            self.go_yearly_price_id.as_deref(),
            self.pro_yearly_price_id.as_deref(),
        ];
        let mut unique = prices.iter().flatten().collect::<Vec<_>>();
        unique.sort_unstable();
        if unique.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Go and Pro monthly and yearly Stripe Prices must all be distinct",
            ));
        }
        Ok(())
    }
    pub(super) fn price(&self, plan: &str, interval: &str) -> Option<&str> {
        match (plan, interval) {
            ("go", "month") => self.go_price_id.as_deref(),
            ("pro", "month") => self.pro_price_id.as_deref(),
            ("go", "year") => self.go_yearly_price_id.as_deref(),
            ("pro", "year") => self.pro_yearly_price_id.as_deref(),
            _ => None,
        }
    }
    pub(super) fn plan_for_price(&self, price_id: &str) -> Option<&'static str> {
        if self.go_price_id.as_deref() == Some(price_id)
            || self.go_yearly_price_id.as_deref() == Some(price_id)
        {
            Some("go")
        } else if self.pro_price_id.as_deref() == Some(price_id)
            || self.pro_yearly_price_id.as_deref() == Some(price_id)
        {
            Some("pro")
        } else {
            None
        }
    }
    pub(super) fn interval_for_price(&self, price_id: &str) -> Option<&'static str> {
        if self.go_price_id.as_deref() == Some(price_id)
            || self.pro_price_id.as_deref() == Some(price_id)
        {
            Some("month")
        } else if self.go_yearly_price_id.as_deref() == Some(price_id)
            || self.pro_yearly_price_id.as_deref() == Some(price_id)
        {
            Some("year")
        } else {
            None
        }
    }
}
fn optional(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.is_empty())
}
fn contact_email(key: &str) -> io::Result<Option<String>> {
    match optional(key) {
        None => Ok(None),
        Some(value) => deskfleet_control_store::normalize_email(&value)
            .map(Some)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn complete() -> BillingConfig {
        BillingConfig {
            hosted: true,
            stripe_secret_key: Some("sk".into()),
            stripe_webhook_secret: Some("whsec".into()),
            go_price_id: Some("price_go".into()),
            pro_price_id: Some("price_pro".into()),
            go_yearly_price_id: Some("price_go_year".into()),
            pro_yearly_price_id: Some("price_pro_year".into()),
            portal_configuration_id: Some("bpc".into()),
            enterprise_contact_email: None,
            statsig_server_key: None,
            statsig_environment: None,
        }
    }
    #[test]
    fn self_hosted_has_no_payments_and_partial_configuration_is_rejected() {
        let mut config = BillingConfig::default();
        assert!(!config.enabled());
        assert!(config.validate().is_ok());
        config.stripe_secret_key = Some("test".into());
        assert!(config.validate().is_err());
        config.hosted = true;
        assert!(config.validate().is_err());
    }
    #[test]
    fn payments_require_all_four_prices_and_one_portal() {
        let mut config = complete();
        assert!(config.validate().is_ok());
        assert!(config.enabled());
        config.pro_yearly_price_id = None;
        assert!(config.validate().is_err());
        assert!(!config.enabled());
        config = complete();
        config.portal_configuration_id = None;
        assert!(config.validate().is_err());
        assert!(!config.enabled());

        config = complete();
        config.hosted = false;
        assert!(config.validate().is_err());
        assert!(!config.enabled());
    }
    #[test]
    fn duplicate_price_ids_are_rejected() {
        let mut config = complete();
        config.go_yearly_price_id = Some("price_go".into());
        assert!(config.validate().is_err());
    }
    #[test]
    fn enterprise_contact_email_is_optional_and_normalized() {
        assert_eq!(contact_email("DESKFLEET_MISSING_CONTACT").unwrap(), None);
        let email = deskfleet_control_store::normalize_email("Sales@Example.COM").unwrap();
        assert_eq!(email, "sales@example.com");
        assert!(deskfleet_control_store::normalize_email("not-an-email").is_err());
    }
}
