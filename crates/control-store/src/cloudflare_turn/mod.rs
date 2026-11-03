//! Private Cloudflare credentials and replaceable, period-attributed usage snapshots.
pub(crate) mod metering;
mod usage;
pub use usage::CloudflareTurnUsageQuery;

use crate::entities::{
    cp_billing_profiles as profiles, cp_cloudflare_turn_settings as settings,
    cp_cloudflare_turn_sources as sources, cp_site_admins as admins, cp_site_audit as audit,
};
use crate::{ControlStore, Error, Result, now_ms, one_query};
use deskfleet_protocol::control::{CloudflareTurnSettings, CloudflareTurnSettingsUpdate};
use sea_orm::sea_query::{Asterisk, Expr, ExprTrait, LockType, Query};
use sea_orm::{ConnectionTrait, QueryResult, TransactionTrait};
use serde_json::json;

pub(crate) async fn metering(
    db: &impl ConnectionTrait,
    team_id: Option<i64>,
    now: i64,
) -> Result<QueryResult> {
    let period = if let Some(team) = team_id {
        let anchor = one_query(
            db,
            Query::select()
                .column(profiles::Column::PeriodAnchor)
                .from(profiles::Entity)
                .and_where(Expr::col(profiles::Column::TeamId).eq(team)),
        )
        .await?
        .try_get("", "period_anchor")?;
        Some(crate::billing::period_at(anchor, now))
    } else {
        None
    };
    one_query(
        db,
        &metering::query(
            Expr::val(team_id),
            Expr::val(now),
            Expr::val(period.map(|p| p.0)),
            Expr::val(period.map(|p| p.1)),
        ),
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
            one_query(
                &self.db,
                Query::select()
                    .column(Asterisk)
                    .from(settings::Entity)
                    .and_where(Expr::col(settings::Column::Singleton)),
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
            .query_one(
                Query::select()
                    .column(admins::Column::UserId)
                    .from(admins::Entity)
                    .and_where(Expr::col(admins::Column::UserId).eq(user_id))
                    .lock(LockType::Share),
            )
            .await?
            .is_none()
        {
            return Err(Error::Forbidden);
        }
        let previous = config(
            one_query(
                &tx,
                Query::select()
                    .column(Asterisk)
                    .from(settings::Entity)
                    .and_where(Expr::col(settings::Column::Singleton))
                    .lock(LockType::Update),
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
            tx.execute(
                Query::update()
                    .table(sources::Entity)
                    .value(
                        sources::Column::AnalyticsToken,
                        next.analytics_token.as_str(),
                    )
                    .and_where(Expr::col(sources::Column::AccountId).eq(next.account_id.as_str()))
                    .and_where(Expr::col(sources::Column::KeyId).eq(next.key_id.as_str()))
                    .and_where(Expr::col(sources::Column::AnalyticsToken).ne("")),
            )
            .await?;
        }
        tx.execute(
            Query::update()
                .table(settings::Entity)
                .value(settings::Column::Enabled, next.enabled)
                .value(settings::Column::AccountId, next.account_id)
                .value(settings::Column::KeyId, next.key_id)
                .value(settings::Column::ApiToken, next.api_token)
                .value(settings::Column::AnalyticsToken, next.analytics_token)
                .and_where(Expr::col(settings::Column::Singleton)),
        )
        .await?;
        tx.execute(
            Query::insert()
                .into_table(audit::Entity)
                .columns([
                    audit::Column::ActorUserId,
                    audit::Column::Source,
                    audit::Column::Action,
                    audit::Column::BeforeValue,
                    audit::Column::AfterValue,
                    audit::Column::OccurredAt,
                ])
                .values_panic([
                    user_id.into(),
                    "user".into(),
                    "cloudflare.turn.settings.update".into(),
                    json!(before).into(),
                    json!(after).into(),
                    now_ms().into(),
                ]),
        )
        .await?;
        tx.commit().await?;
        Ok(after)
    }
}
