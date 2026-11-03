//! Private Cloudflare credentials and replaceable, period-attributed usage snapshots.
mod usage;
pub use usage::CloudflareTurnUsageQuery;

use crate::{ControlStore, Error, Result, now_ms, one, sql};
use deskfleet_protocol::control::{CloudflareTurnSettings, CloudflareTurnSettingsUpdate};
use sea_orm::{ConnectionTrait, QueryResult, TransactionTrait};
use serde_json::json;

pub(crate) async fn metering(
    db: &impl ConnectionTrait,
    team_id: Option<i64>,
    now: i64,
) -> Result<QueryResult> {
    let period = if let Some(team) = team_id {
        let anchor = one(
            db,
            "SELECT period_anchor FROM cp_billing_profiles WHERE team_id=$1",
            vec![team.into()],
        )
        .await?
        .try_get("", "period_anchor")?;
        Some(crate::billing::period_at(anchor, now))
    } else {
        None
    };
    one(
        db,
        include_str!("metering.sql"),
        vec![
            team_id.into(),
            now.into(),
            period.map(|p| p.0).into(),
            period.map(|p| p.1).into(),
        ],
    )
    .await
}

/// Server-only credentials. Deliberately neither `Debug` nor serializable.
#[derive(Clone)]
pub struct CloudflareTurnConfig {
    pub enabled: bool,
    pub account_id: String,
    pub key_id: String,
    pub api_token: String,
    pub analytics_token: String,
}

impl CloudflareTurnConfig {
    fn settings(&self) -> CloudflareTurnSettings {
        CloudflareTurnSettings {
            enabled: self.enabled,
            account_id: self.account_id.clone(),
            key_id: self.key_id.clone(),
            api_token_configured: !self.api_token.is_empty(),
            analytics_token_configured: !self.analytics_token.is_empty(),
        }
    }
}

fn config(row: QueryResult) -> Result<CloudflareTurnConfig> {
    Ok(CloudflareTurnConfig {
        enabled: row.try_get("", "enabled")?,
        account_id: row.try_get("", "account_id")?,
        key_id: row.try_get("", "key_id")?,
        api_token: row.try_get("", "api_token")?,
        analytics_token: row.try_get("", "analytics_token")?,
    })
}

fn identifier(value: &str) -> Result<String> {
    let value = value.trim();
    if !value.is_empty() && (value.len() != 32 || !value.bytes().all(|c| c.is_ascii_hexdigit())) {
        return Err(Error::Invalid(
            "Cloudflare account and TURN key IDs must be 32 hexadecimal characters",
        ));
    }
    Ok(value.to_owned())
}

fn token(value: Option<&str>, previous: String) -> Result<String> {
    let Some(value) = value else {
        return Ok(previous);
    };
    if value.len() > 4096 || value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(Error::Invalid(
            "Cloudflare tokens must not contain whitespace or exceed 4096 bytes",
        ));
    }
    Ok(value.to_owned())
}

impl ControlStore {
    pub async fn cloudflare_turn_config(&self) -> Result<CloudflareTurnConfig> {
        config(
            one(
                &self.db,
                "SELECT * FROM cp_cloudflare_turn_settings WHERE singleton",
                vec![],
            )
            .await?,
        )
    }

    pub async fn read_cloudflare_turn_settings(
        &self,
        user_id: &str,
    ) -> Result<CloudflareTurnSettings> {
        if !self.is_site_admin(user_id).await? {
            return Err(Error::Forbidden);
        }
        Ok(self.cloudflare_turn_config().await?.settings())
    }

    /// Serialize administrator authorization and changes; audit only redacted settings.
    pub async fn update_cloudflare_turn_settings(
        &self,
        user_id: &str,
        input: &CloudflareTurnSettingsUpdate,
    ) -> Result<CloudflareTurnSettings> {
        let tx = self.db.begin().await?;
        if tx
            .query_one_raw(sql(
                "SELECT user_id FROM cp_site_admins WHERE user_id=$1 FOR SHARE",
                vec![user_id.into()],
            ))
            .await?
            .is_none()
        {
            return Err(Error::Forbidden);
        }
        let previous = config(
            one(
                &tx,
                "SELECT * FROM cp_cloudflare_turn_settings WHERE singleton FOR UPDATE",
                vec![],
            )
            .await?,
        )?;
        let before = previous.settings();
        let next = CloudflareTurnConfig {
            enabled: input.enabled,
            account_id: identifier(&input.account_id)?,
            key_id: identifier(&input.key_id)?,
            api_token: token(input.api_token.as_deref(), previous.api_token)?,
            analytics_token: token(input.analytics_token.as_deref(), previous.analytics_token)?,
        };
        if next.enabled
            && [
                &next.account_id,
                &next.key_id,
                &next.api_token,
                &next.analytics_token,
            ]
            .iter()
            .any(|v| v.is_empty())
        {
            return Err(Error::Invalid(
                "Cloudflare TURN requires an account ID, TURN key ID, API token, and analytics token",
            ));
        }
        let after = next.settings();
        if !next.analytics_token.is_empty() {
            tx.execute_raw(sql("UPDATE cp_cloudflare_turn_sources SET analytics_token=$3 WHERE account_id=$1 AND key_id=$2 AND analytics_token<>''",vec![next.account_id.as_str().into(),next.key_id.as_str().into(),next.analytics_token.as_str().into()])).await?;
        }
        tx.execute_raw(sql("UPDATE cp_cloudflare_turn_settings SET enabled=$1,account_id=$2,key_id=$3,api_token=$4,analytics_token=$5 WHERE singleton", vec![next.enabled.into(),next.account_id.into(),next.key_id.into(),next.api_token.into(),next.analytics_token.into()])).await?;
        tx.execute_raw(sql("INSERT INTO cp_site_audit(actor_user_id,source,action,before_value,after_value,occurred_at) VALUES($1,'user','cloudflare.turn.settings.update',$2,$3,$4)", vec![user_id.into(),json!(before).into(),json!(after).into(),now_ms().into()])).await?;
        tx.commit().await?;
        Ok(after)
    }
}
