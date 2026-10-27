use std::{env, io};

#[derive(Clone, Debug, Default)]
pub struct BillingConfig {
    pub hosted: bool,
    pub stripe_secret_key: Option<String>,
    pub stripe_webhook_secret: Option<String>,
    pub go_price_id: Option<String>,
    pub pro_price_id: Option<String>,
    pub portal_configuration_id: Option<String>,
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
            portal_configuration_id: optional("DESKFLEET_STRIPE_PORTAL_CONFIGURATION_ID"),
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
            && self.portal_configuration_id.is_some()
    }
    pub fn validate(&self) -> io::Result<()> {
        let configured = [
            &self.stripe_secret_key,
            &self.stripe_webhook_secret,
            &self.go_price_id,
            &self.pro_price_id,
            &self.portal_configuration_id,
        ]
        .iter()
        .filter(|value| value.is_some())
        .count();
        if configured > 0 && (!self.hosted || configured != 5) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Stripe requires hosted mode and all five Stripe settings",
            ));
        }
        if self.go_price_id.is_some() && self.go_price_id == self.pro_price_id {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Go and Pro require different Stripe Prices",
            ));
        }
        Ok(())
    }
    pub(super) fn price(&self, plan: &str) -> Option<&str> {
        match plan {
            "go" => self.go_price_id.as_deref(),
            "pro" => self.pro_price_id.as_deref(),
            _ => None,
        }
    }
}
fn optional(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
