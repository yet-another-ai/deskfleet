//! Local evaluation keeps account attributes and each stream poll off the network.
use deskfleet_protocol::control::User;
use statsig_rust::{Statsig, StatsigOptions, StatsigUserBuilder};
use std::sync::Arc;

pub(super) const GATE: &str = "super_agent";

pub(crate) struct Rollout(Option<Arc<Statsig>>);

impl Rollout {
    pub(crate) fn new(key: Option<&str>, environment: Option<&str>) -> Self {
        let Some(key) = key else { return Self(None) };
        let options = StatsigOptions {
            environment: Some(environment.unwrap_or("production").to_owned()),
            disable_all_logging: Some(true),
            disable_country_lookup: Some(true),
            enable_id_lists: Some(true),
            ..Default::default()
        };
        let sdk = Arc::new(Statsig::new(key, Some(Arc::new(options))));
        let initializing = Arc::clone(&sdk);
        tokio::spawn(async move {
            if initializing.initialize().await.is_err() {
                tracing::warn!(
                    "Super Agent rollout could not load initial Statsig gate definitions"
                );
            }
        });
        Self(Some(sdk))
    }

    pub(super) fn enabled(&self, user: &User, team: i64) -> bool {
        self.0.as_ref().is_some_and(|sdk| {
            let identity = StatsigUserBuilder::new_with_user_id(user.id.as_str())
                .custom_ids(Some([("teamID", team.to_string())]))
                .email(user.email.clone())
                .build();
            sdk.check_gate(&identity, GATE)
        })
    }

    #[cfg(test)]
    pub(super) fn offline(sdk: Arc<Statsig>) -> Self {
        Self(Some(sdk))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_server_key_keeps_the_rollout_closed() {
        let user = User {
            id: "account".into(),
            name: "Account".into(),
            email: None,
        };
        assert!(!Rollout::new(None, Some("development")).enabled(&user, 1));
    }
}
