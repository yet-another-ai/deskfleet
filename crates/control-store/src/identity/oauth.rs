//! Provider subjects identify accounts independently of their current email address.
use super::{normalize_email, user};
use crate::{ControlStore, Error, Result, name, one, sql};
use deskfleet_protocol::control::User;
use sea_orm::{ConnectionTrait, TransactionTrait};

#[derive(Clone, Copy)]
enum Provider {
    Github,
    Google,
}

impl Provider {
    fn table(self) -> &'static str {
        match self {
            Self::Github => "cp_github_identities",
            Self::Google => "cp_google_identities",
        }
    }
}

impl ControlStore {
    pub async fn authentication_methods(&self, user_id: &str) -> Result<serde_json::Value> {
        let row = one(&self.db,
            "SELECT password_hash IS NOT NULL AS password, EXISTS(SELECT 1 FROM cp_passkeys WHERE user_id=u.id) AS passkey, EXISTS(SELECT 1 FROM cp_github_identities WHERE user_id=u.id) AS github, EXISTS(SELECT 1 FROM cp_google_identities WHERE user_id=u.id) AS google FROM cp_users u WHERE id=$1",
            vec![user_id.into()]).await?;
        Ok(serde_json::json!({
            "password": row.try_get::<bool>("", "password")?,
            "passkey": row.try_get::<bool>("", "passkey")?,
            "github": row.try_get::<bool>("", "github")?,
            "google": row.try_get::<bool>("", "google")?,
        }))
    }

    pub async fn github_account(&self, subject: &str) -> Result<User> {
        self.oauth_account(Provider::Github, subject).await
    }

    pub async fn google_account(&self, subject: &str) -> Result<User> {
        self.oauth_account(Provider::Google, subject).await
    }

    /// Resolve an established GitHub identity or create an account without linking by email.
    pub async fn github_user(
        &self,
        subject: &str,
        email: &str,
        display_name: &str,
        accepted_terms: bool,
    ) -> Result<User> {
        self.oauth_user(
            Provider::Github,
            subject,
            email,
            display_name,
            accepted_terms,
        )
        .await
    }

    /// Resolve an established Google identity or create an account without linking by email.
    pub async fn google_user(
        &self,
        subject: &str,
        email: &str,
        display_name: &str,
        accepted_terms: bool,
    ) -> Result<User> {
        self.oauth_user(
            Provider::Google,
            subject,
            email,
            display_name,
            accepted_terms,
        )
        .await
    }

    async fn oauth_account(&self, provider: Provider, subject: &str) -> Result<User> {
        let table = provider.table();
        let row = one(
            &self.db,
            &format!("SELECT u.id,u.name,u.email FROM {table} g JOIN cp_users u ON u.id=g.user_id WHERE g.subject=$1 AND NOT u.disabled AND u.email_verified"),
            vec![subject.into()],
        )
        .await?;
        user(&row)
    }

    async fn oauth_user(
        &self,
        provider: Provider,
        subject: &str,
        email: &str,
        display_name: &str,
        accepted_terms: bool,
    ) -> Result<User> {
        let table = provider.table();
        let tx = self.db.begin().await?;
        tx.execute_raw(sql(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 761946022))",
            vec![subject.into()],
        ))
        .await?;
        if let Some(row) = tx
            .query_one_raw(sql(
                &format!("SELECT u.id,u.name,u.email,u.disabled,u.email_verified FROM {table} g JOIN cp_users u ON u.id=g.user_id WHERE g.subject=$1"),
                vec![subject.into()],
            ))
            .await?
        {
            if row.try_get::<bool>("", "disabled")? || !row.try_get::<bool>("", "email_verified")? {
                return Err(Error::Unauthorized);
            }
            return user(&row);
        }
        let enabled: bool = one(
            &tx,
            "SELECT enabled FROM cp_registration_policy WHERE singleton FOR SHARE",
            vec![],
        )
        .await?
        .try_get("", "enabled")?;
        if !enabled {
            return Err(Error::Invalid("registration disabled"));
        }
        let settings = one(&tx, "SELECT terms_of_service_url,privacy_terms_url FROM cp_site_settings WHERE singleton FOR SHARE", vec![]).await?;
        let terms: String = settings.try_get("", "terms_of_service_url")?;
        let privacy: String = settings.try_get("", "privacy_terms_url")?;
        if !accepted_terms && (!terms.is_empty() || !privacy.is_empty()) {
            return Err(Error::Invalid("terms acceptance required"));
        }
        let email = normalize_email(email)?;
        let row = tx.query_one_raw(sql("INSERT INTO cp_users(id,name,email,email_verified) VALUES($1,$2,$3,TRUE) ON CONFLICT(email) DO NOTHING RETURNING id,name,email", vec![uuid::Uuid::now_v7().to_string().into(),name(display_name)?.into(),email.into()])).await?.ok_or(Error::Conflict("account already exists"))?;
        let account = user(&row)?;
        tx.execute_raw(sql(
            &format!("INSERT INTO {table}(subject,user_id) VALUES($1,$2)"),
            vec![subject.into(), account.id.clone().into()],
        ))
        .await?;
        tx.commit().await?;
        Ok(account)
    }
}
