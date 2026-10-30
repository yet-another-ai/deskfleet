use std::{env, io};

/// GitHub App user grants are separate from the OAuth app used for login.
#[derive(Clone)]
pub struct GithubAppConfig {
    pub slug: String,
    pub client_id: String,
    pub client_secret: String,
    pub callback_url: String,
    pub token_url: String,
    pub user_url: String,
    pub api_url: String,
}

impl GithubAppConfig {
    pub fn from_env(public_url: &str) -> io::Result<Option<Self>> {
        Self::from_values(
            public_url,
            env::var("DESKFLEET_GITHUB_APP_SLUG").ok(),
            env::var("DESKFLEET_GITHUB_APP_CLIENT_ID").ok(),
            env::var("DESKFLEET_GITHUB_APP_CLIENT_SECRET").ok(),
        )
    }

    fn from_values(
        public_url: &str,
        slug: Option<String>,
        client_id: Option<String>,
        client_secret: Option<String>,
    ) -> io::Result<Option<Self>> {
        if slug.is_none() && client_id.is_none() && client_secret.is_none() {
            return Ok(None);
        }
        let invalid = || {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "GitHub App slug, client ID and client secret must all be configured",
            )
        };
        let slug = slug.filter(|value| !value.is_empty()).ok_or_else(invalid)?;
        if !slug.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid GitHub App slug",
            ));
        }
        Ok(Some(Self {
            slug,
            client_id: client_id
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(invalid)?,
            client_secret: client_secret
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(invalid)?,
            callback_url: format!(
                "{}/api/integrations/github/callback",
                public_url.trim_end_matches('/')
            ),
            token_url: "https://github.com/login/oauth/access_token".into(),
            user_url: "https://api.github.com/user".into(),
            api_url: "https://api.github.com".into(),
        }))
    }

    pub fn manage_url(&self) -> String {
        format!("https://github.com/apps/{}/installations/new", self.slug)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_app_configuration_is_optional_and_separate() {
        assert!(
            GithubAppConfig::from_values("https://fleet.test", None, None, None)
                .unwrap()
                .is_none()
        );
        assert!(
            GithubAppConfig::from_values(
                "https://fleet.test",
                Some("deskfleet".into()),
                None,
                None
            )
            .is_err()
        );
        for slug in ["../other", "app?query=1", "app/name"] {
            assert!(
                GithubAppConfig::from_values(
                    "https://fleet.test",
                    Some(slug.into()),
                    Some("client".into()),
                    Some("secret".into())
                )
                .is_err()
            );
        }
        let config = GithubAppConfig::from_values(
            "https://fleet.test/",
            Some("deskfleet-app".into()),
            Some("client".into()),
            Some("secret".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            config.callback_url,
            "https://fleet.test/api/integrations/github/callback"
        );
        assert_eq!(
            config.manage_url(),
            "https://github.com/apps/deskfleet-app/installations/new"
        );
    }
}
