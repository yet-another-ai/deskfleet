//! Per-user GitHub App grants. Tokens stay in central storage, never in client settings.
use crate::{ControlStore, Error, Result, now_ms, one, sql};
use sea_orm::{ConnectionTrait, DatabaseTransaction, TransactionTrait};
use serde::Serialize;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAppStatus {
    pub authorized: bool,
    pub login: Option<String>,
    pub act_as_you: bool,
}

/// Secret material returned by GitHub; deliberately not serializable or printable.
pub struct GithubAppGrant {
    pub subject: String,
    pub login: String,
    pub access_token: String,
    pub expires_at: Option<i64>,
    pub refresh_token: Option<String>,
    pub refresh_expires_at: Option<i64>,
}

/// Credentials used only by the central server when consuming an enabled grant.
pub struct GithubAppTokens {
    pub access_token: String,
    pub expires_at: Option<i64>,
    pub refresh_token: Option<String>,
    pub refresh_expires_at: Option<i64>,
}

/// Holds the grant row while a single-use refresh token is being rotated.
/// The database lock serializes refreshes across API instances.
pub struct GithubAppAccess {
    pub tokens: GithubAppTokens,
    tx: DatabaseTransaction,
    user_id: String,
}

impl GithubAppAccess {
    /// Save rotated credentials without changing the user's identity or opt-in.
    /// Release the lock before making the repository request.
    pub async fn finish(mut self, refreshed: Option<GithubAppTokens>) -> Result<String> {
        if let Some(tokens) = refreshed {
            self.tx.execute_raw(sql(
                "UPDATE cp_github_app_authorizations SET access_token=$2,expires_at=$3,refresh_token=$4,refresh_expires_at=$5 WHERE user_id=$1",
                vec![self.user_id.into(),tokens.access_token.clone().into(),tokens.expires_at.into(),tokens.refresh_token.clone().into(),tokens.refresh_expires_at.into()],
            )).await?;
            self.tokens = tokens;
        }
        self.tx.commit().await?;
        Ok(self.tokens.access_token)
    }
}

impl ControlStore {
    /// Lock an explicitly enabled App grant before using or refreshing it.
    pub async fn github_app_access(
        &self,
        user_id: &str,
        client_id: &str,
    ) -> Result<Option<GithubAppAccess>> {
        let tx = self.db.begin().await?;
        let row = tx.query_one_raw(sql(
            "SELECT access_token,expires_at,refresh_token,refresh_expires_at FROM cp_github_app_authorizations WHERE user_id=$1 AND client_id=$2 AND act_as_you FOR UPDATE",
            vec![user_id.into(),client_id.into()],
        )).await?;
        let Some(row) = row else {
            return Ok(None);
        };
        Ok(Some(GithubAppAccess {
            tokens: GithubAppTokens {
                access_token: row.try_get("", "access_token")?,
                expires_at: row.try_get("", "expires_at")?,
                refresh_token: row.try_get("", "refresh_token")?,
                refresh_expires_at: row.try_get("", "refresh_expires_at")?,
            },
            tx,
            user_id: user_id.to_owned(),
        }))
    }

    pub async fn github_app_status(
        &self,
        user_id: &str,
        client_id: &str,
    ) -> Result<GithubAppStatus> {
        let row = self.db.query_one_raw(sql(
            "SELECT login,act_as_you,(expires_at IS NULL OR expires_at>$3 OR (refresh_token IS NOT NULL AND COALESCE(refresh_expires_at>$3,FALSE))) AS authorized FROM cp_github_app_authorizations WHERE user_id=$1 AND client_id=$2",
            vec![user_id.into(),client_id.into(),now_ms().into()],
        )).await?;
        let Some(row) = row else {
            return Ok(GithubAppStatus::default());
        };
        let authorized: bool = row.try_get("", "authorized")?;
        Ok(GithubAppStatus {
            authorized,
            login: Some(row.try_get("", "login")?),
            act_as_you: authorized && row.try_get::<bool>("", "act_as_you")?,
        })
    }

    /// Callback must still belong to its original active browser session at commit time.
    pub async fn save_github_app_grant(
        &self,
        user_id: &str,
        session_id: &str,
        client_id: &str,
        grant: GithubAppGrant,
    ) -> Result<()> {
        let tx = self.db.begin().await?;
        one(
            &tx,
            "SELECT id FROM cp_users WHERE id=$1 AND NOT disabled AND email_verified FOR SHARE",
            vec![user_id.into()],
        )
        .await
        .map_err(|error| {
            if matches!(error, Error::NotFound) {
                Error::Unauthorized
            } else {
                error
            }
        })?;
        one(&tx, "SELECT id FROM cp_login_sessions WHERE id=$1 AND user_id=$2 AND NOT revoked AND expires_at>$3 FOR SHARE", vec![session_id.into(),user_id.into(),now_ms().into()]).await.map_err(|error| if matches!(error, Error::NotFound) { Error::Unauthorized } else { error })?;
        tx.execute_raw(sql(
            "INSERT INTO cp_github_app_authorizations(user_id,client_id,subject,login,access_token,expires_at,refresh_token,refresh_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id) DO UPDATE SET client_id=excluded.client_id,subject=excluded.subject,login=excluded.login,access_token=excluded.access_token,expires_at=excluded.expires_at,refresh_token=excluded.refresh_token,refresh_expires_at=excluded.refresh_expires_at,act_as_you=FALSE",
            vec![user_id.into(),client_id.into(),grant.subject.into(),grant.login.into(),grant.access_token.into(),grant.expires_at.into(),grant.refresh_token.into(),grant.refresh_expires_at.into()],
        )).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn set_github_act_as_you(
        &self,
        user_id: &str,
        client_id: &str,
        enabled: bool,
    ) -> Result<()> {
        let result = self.db.execute_raw(sql(
            "UPDATE cp_github_app_authorizations SET act_as_you=$3 WHERE user_id=$1 AND client_id=$2 AND (NOT $3 OR expires_at IS NULL OR expires_at>$4 OR (refresh_token IS NOT NULL AND COALESCE(refresh_expires_at>$4,FALSE)))",
            vec![user_id.into(),client_id.into(),enabled.into(),now_ms().into()],
        )).await?;
        if enabled && result.rows_affected() == 0 {
            return Err(Error::Invalid("GitHub App authorization is required"));
        }
        Ok(())
    }
}
