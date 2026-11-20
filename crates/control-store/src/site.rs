//! Installation-wide settings and explicit operator-managed administrator grants.
use crate::entities::{
    cp_site_admins as admins, cp_site_audit as audit, cp_site_settings as site,
    cp_user_marketing_attribution as attribution, cp_users as users,
};
use crate::{
    ControlStore, Error, Result, name, now_ms,
    policies::{SiteAction, SitePolicy, authorize},
};
use deskfleet_protocol::control::{MarketingAttribution, SiteSettings, TelemetryConsentUpdate};
use sea_orm::sea_query::{Expr, ExprTrait, JoinType, LockType, OnConflict, Order, Query};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect, Set, TransactionTrait,
};
use serde_json::{Value, json};

fn settings(row: site::Model) -> SiteSettings {
    SiteSettings {
        site_name: row.site_name,
        announcement: row.announcement,
        allow_team_creation: row.allow_team_creation,
        terms_of_service_url: row.terms_of_service_url,
        privacy_terms_url: row.privacy_terms_url,
        telemetry_enabled: row.telemetry_enabled,
    }
}

fn attribution_field(value: Option<&String>) -> Result<Option<String>> {
    let Some(trimmed) = value
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    else {
        return Ok(None);
    };
    if trimmed.len() > 256 {
        return Err(Error::Invalid(
            "marketing attribution parameter must contain at most 256 bytes",
        ));
    }
    Ok(Some(trimmed.to_owned()))
}

fn terms_url(value: &str) -> Result<&str> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(value);
    }
    let invalid =
        || Error::Invalid("terms URLs must be absolute HTTP or HTTPS URLs without credentials");
    let url = url::Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || value
            .split_once("://")
            .is_none_or(|(scheme, _)| !scheme.eq_ignore_ascii_case(url.scheme()))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid());
    }
    Ok(value)
}

impl ControlStore {
    /// Look up the current grant instead of caching it in login sessions.
    pub async fn is_site_admin(&self, user_id: &str) -> Result<bool> {
        Ok(admins::Entity::find_by_id(user_id)
            .one(&self.db)
            .await?
            .is_some())
    }
    /// Safe public settings; no credentials or deployment configuration live here.
    pub async fn site_settings(&self) -> Result<SiteSettings> {
        Ok(settings(
            site::Entity::find_by_id(true)
                .one(&self.db)
                .await?
                .ok_or(Error::NotFound)?,
        ))
    }
    pub async fn read_site_settings(&self, user_id: &str) -> Result<SiteSettings> {
        authorize(
            &SitePolicy::new(self.is_site_admin(user_id).await?),
            SiteAction::ReadSettings,
        )?;
        self.site_settings().await
    }
    /// Replace general site settings and record their previous and new values.
    pub async fn update_site_settings(
        &self,
        user_id: &str,
        input: &SiteSettings,
    ) -> Result<SiteSettings> {
        let tx = self.db.begin().await?;
        // A concurrent revocation waits for this write, or finishes first and
        // denies it. The grant remains valid until the settings commit.
        let is_admin = admins::Entity::find_by_id(user_id)
            .lock_shared()
            .one(&tx)
            .await?
            .is_some();
        authorize(&SitePolicy::new(is_admin), SiteAction::UpdateSettings)?;
        let site_name = name(&input.site_name)?;
        let terms_of_service_url = terms_url(&input.terms_of_service_url)?;
        let privacy_terms_url = terms_url(&input.privacy_terms_url)?;
        if input.announcement.len() > 10_000 {
            return Err(Error::Invalid(
                "announcement must contain at most 10000 bytes",
            ));
        }
        let before = settings(
            site::Entity::find_by_id(true)
                .lock_exclusive()
                .one(&tx)
                .await?
                .ok_or(Error::NotFound)?,
        );
        let after = SiteSettings {
            site_name: site_name.into(),
            announcement: input.announcement.clone(),
            allow_team_creation: input.allow_team_creation,
            terms_of_service_url: terms_of_service_url.into(),
            privacy_terms_url: privacy_terms_url.into(),
            telemetry_enabled: input.telemetry_enabled,
        };
        site::Entity::update_many()
            .col_expr(site::Column::SiteName, Expr::val(site_name))
            .col_expr(
                site::Column::Announcement,
                Expr::val(input.announcement.clone()),
            )
            .col_expr(
                site::Column::AllowTeamCreation,
                Expr::val(input.allow_team_creation),
            )
            .col_expr(
                site::Column::TermsOfServiceUrl,
                Expr::val(terms_of_service_url),
            )
            .col_expr(site::Column::PrivacyTermsUrl, Expr::val(privacy_terms_url))
            .col_expr(
                site::Column::TelemetryEnabled,
                Expr::val(input.telemetry_enabled),
            )
            .filter(site::Column::Singleton.eq(true))
            .exec(&tx)
            .await?;
        audit::Entity::insert(audit::ActiveModel {
            actor_user_id: Set(Some(user_id.into())),
            source: Set("user".into()),
            action: Set("settings.update".into()),
            before_value: Set(json!(before)),
            after_value: Set(json!(after)),
            occurred_at: Set(now_ms()),
            ..Default::default()
        })
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(after)
    }
    /// Read the installation-wide proof-of-work requirement for public authentication.
    pub async fn captcha_enabled(&self) -> Result<bool> {
        site::Entity::find_by_id(true)
            .select_only()
            .column(site::Column::CaptchaEnabled)
            .into_tuple::<bool>()
            .one(&self.db)
            .await?
            .ok_or(Error::NotFound)
    }

    /// Update the proof-of-work requirement with an administrator audit entry.
    pub async fn set_captcha_enabled(&self, actor: &str, enabled: bool) -> Result<()> {
        let tx = self.db.begin().await?;
        let is_admin = admins::Entity::find_by_id(actor)
            .lock_shared()
            .one(&tx)
            .await?
            .is_some();
        authorize(&SitePolicy::new(is_admin), SiteAction::UpdateSettings)?;
        let previous = site::Entity::find_by_id(true)
            .select_only()
            .column(site::Column::CaptchaEnabled)
            .lock_exclusive()
            .into_tuple::<bool>()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        site::Entity::update_many()
            .col_expr(site::Column::CaptchaEnabled, Expr::val(enabled))
            .filter(site::Column::Singleton.eq(true))
            .exec(&tx)
            .await?;
        audit::Entity::insert(audit::ActiveModel {
            actor_user_id: Set(Some(actor.into())),
            source: Set("user".into()),
            action: Set("settings.update".into()),
            before_value: Set(json!({"captchaEnabled": previous})),
            after_value: Set(json!({"captchaEnabled": enabled})),
            occurred_at: Set(now_ms()),
            ..Default::default()
        })
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Persist or revoke a user's opt-in telemetry consent and first-touch marketing attribution.
    pub async fn update_user_telemetry_consent(
        &self,
        user_id: &str,
        input: &TelemetryConsentUpdate,
    ) -> Result<()> {
        if !input.consented {
            attribution::Entity::delete_by_id(user_id)
                .exec(&self.db)
                .await?;
            return Ok(());
        }
        let incoming = input.attribution.as_ref();
        let gclid = attribution_field(incoming.and_then(|a| a.gclid.as_ref()))?;
        let gbraid = attribution_field(incoming.and_then(|a| a.gbraid.as_ref()))?;
        let wbraid = attribution_field(incoming.and_then(|a| a.wbraid.as_ref()))?;
        let utm_source = attribution_field(incoming.and_then(|a| a.utm_source.as_ref()))?;
        let utm_medium = attribution_field(incoming.and_then(|a| a.utm_medium.as_ref()))?;
        let utm_campaign = attribution_field(incoming.and_then(|a| a.utm_campaign.as_ref()))?;
        let utm_term = attribution_field(incoming.and_then(|a| a.utm_term.as_ref()))?;
        let utm_content = attribution_field(incoming.and_then(|a| a.utm_content.as_ref()))?;
        let ga_client_id = attribution_field(incoming.and_then(|a| a.ga_client_id.as_ref()))?;

        let tx = self.db.begin().await?;
        let site = site::Entity::find_by_id(true)
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        if !site.telemetry_enabled {
            attribution::Entity::delete_by_id(user_id).exec(&tx).await?;
            tx.commit().await?;
            return Ok(());
        }
        let existing = attribution::Entity::find_by_id(user_id)
            .lock_exclusive()
            .one(&tx)
            .await?;
        let active = attribution::ActiveModel {
            user_id: Set(user_id.into()),
            gclid: Set(existing
                .as_ref()
                .and_then(|row| row.gclid.clone())
                .or(gclid)),
            gbraid: Set(existing
                .as_ref()
                .and_then(|row| row.gbraid.clone())
                .or(gbraid)),
            wbraid: Set(existing
                .as_ref()
                .and_then(|row| row.wbraid.clone())
                .or(wbraid)),
            utm_source: Set(existing
                .as_ref()
                .and_then(|row| row.utm_source.clone())
                .or(utm_source)),
            utm_medium: Set(existing
                .as_ref()
                .and_then(|row| row.utm_medium.clone())
                .or(utm_medium)),
            utm_campaign: Set(existing
                .as_ref()
                .and_then(|row| row.utm_campaign.clone())
                .or(utm_campaign)),
            utm_term: Set(existing
                .as_ref()
                .and_then(|row| row.utm_term.clone())
                .or(utm_term)),
            utm_content: Set(existing
                .as_ref()
                .and_then(|row| row.utm_content.clone())
                .or(utm_content)),
            ga_client_id: Set(existing
                .as_ref()
                .and_then(|row| row.ga_client_id.clone())
                .or(ga_client_id)),
            consented_at: Set(existing.map_or_else(now_ms, |row| row.consented_at)),
        };
        attribution::Entity::insert(active)
            .on_conflict(
                OnConflict::column(attribution::Column::UserId)
                    .update_columns([
                        attribution::Column::Gclid,
                        attribution::Column::Gbraid,
                        attribution::Column::Wbraid,
                        attribution::Column::UtmSource,
                        attribution::Column::UtmMedium,
                        attribution::Column::UtmCampaign,
                        attribution::Column::UtmTerm,
                        attribution::Column::UtmContent,
                        attribution::Column::GaClientId,
                        attribution::Column::ConsentedAt,
                    ])
                    .to_owned(),
            )
            .exec_without_returning(&tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
    /// Read consented marketing attribution for server-side conversion delivery.
    pub async fn user_marketing_attribution(
        &self,
        user_id: &str,
    ) -> Result<Option<MarketingAttribution>> {
        let Some(row) = attribution::Entity::find_by_id(user_id)
            .one(&self.db)
            .await?
        else {
            return Ok(None);
        };
        Ok(Some(MarketingAttribution {
            gclid: row.gclid,
            gbraid: row.gbraid,
            wbraid: row.wbraid,
            utm_source: row.utm_source,
            utm_medium: row.utm_medium,
            utm_campaign: row.utm_campaign,
            utm_term: row.utm_term,
            utm_content: row.utm_content,
            ga_client_id: row.ga_client_id,
        }))
    }
    /// Operator-only listing for the server CLI, not an authenticated API.
    pub async fn site_admins(&self) -> Result<Vec<Value>> {
        self.db.query_all(Query::select().columns([(users::Entity, users::Column::Id), (users::Entity, users::Column::Name), (users::Entity, users::Column::Email)])
            .columns([(admins::Entity, admins::Column::GrantedAt), (admins::Entity, admins::Column::Source)])
            .from(admins::Entity).join(JoinType::InnerJoin, users::Entity,
                Expr::col((users::Entity, users::Column::Id)).eq(Expr::col((admins::Entity, admins::Column::UserId))))
            .order_by((admins::Entity, admins::Column::GrantedAt), Order::Asc).order_by((admins::Entity, admins::Column::UserId), Order::Asc))
            .await?.into_iter().map(|row| Ok(json!({"userId":row.try_get::<String>("","id")?,"name":row.try_get::<String>("","name")?,
                "email":row.try_get::<String>("","email")?,"grantedAt":row.try_get::<i64>("","granted_at")?,"source":row.try_get::<String>("","source")?}))).collect()
    }
    /// Grant a known identity through the local operations CLI.
    /// Returns whether the grant changed; repeated grants do not add audit events.
    pub async fn grant_site_admin(&self, user_id: &str) -> Result<bool> {
        self.set_site_admin(user_id, true).await
    }
    /// Revoke through the local operations CLI, including the final administrator.
    /// Operators can recover by granting another already authenticated identity.
    pub async fn revoke_site_admin(&self, user_id: &str) -> Result<bool> {
        self.set_site_admin(user_id, false).await
    }
    async fn set_site_admin(&self, user_id: &str, grant: bool) -> Result<bool> {
        let tx = self.db.begin().await?;
        // Serialize operator changes while permitting audit foreign keys
        // to acquire KEY SHARE during an in-flight settings update.
        users::Entity::find_by_id(user_id)
            .lock(LockType::NoKeyUpdate)
            .select_only()
            .column(users::Column::Id)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        let changed = if grant {
            admins::Entity::insert(admins::ActiveModel {
                user_id: Set(user_id.into()),
                granted_at: Set(now_ms()),
                source: Set("cli".into()),
                ..Default::default()
            })
            .on_conflict(
                OnConflict::column(admins::Column::UserId)
                    .do_nothing()
                    .to_owned(),
            )
            .exec_without_returning(&tx)
            .await?
        } else {
            admins::Entity::delete_by_id(user_id)
                .exec(&tx)
                .await?
                .rows_affected
        } > 0;
        if changed {
            audit::Entity::insert(audit::ActiveModel {
                source: Set("cli".into()),
                action: Set(if grant { "admin.grant" } else { "admin.revoke" }.into()),
                target_user_id: Set(Some(user_id.into())),
                before_value: Set(json!({"siteAdmin":!grant})),
                after_value: Set(json!({"siteAdmin":grant})),
                occurred_at: Set(now_ms()),
                ..Default::default()
            })
            .exec_without_returning(&tx)
            .await?;
        }
        tx.commit().await?;
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::{attribution_field, terms_url};

    #[test]
    fn attribution_fields_trim_empty_values_and_reject_oversized_strings() {
        assert_eq!(attribution_field(None).unwrap(), None);
        assert_eq!(attribution_field(Some(&"   ".into())).unwrap(), None);
        assert_eq!(
            attribution_field(Some(&"  gclid-123  ".into())).unwrap(),
            Some("gclid-123".into())
        );
        assert!(attribution_field(Some(&"x".repeat(256))).is_ok());
        assert!(attribution_field(Some(&"x".repeat(257))).is_err());
    }

    #[test]
    fn terms_urls_allow_empty_or_absolute_web_links_without_credentials() {
        for (input, expected) in [
            ("", ""),
            ("  ", ""),
            (
                " https://example.test/terms?v=2#content ",
                "https://example.test/terms?v=2#content",
            ),
            (
                "http://localhost:8080/privacy",
                "http://localhost:8080/privacy",
            ),
        ] {
            assert_eq!(terms_url(input).unwrap(), expected);
        }
        for input in [
            "/terms",
            "//example.test/privacy",
            "https:example.test/terms",
            "https:example.test/path://terms",
            "not a URL",
            "javascript:alert(1)",
            "data:text/html,test",
            "file:///terms",
            "ftp://example.test/terms",
            "https://",
            "https://user@example.test/terms",
            "https://user:secret@example.test/privacy",
        ] {
            assert!(
                terms_url(input).is_err(),
                "accepted invalid terms URL {input}"
            );
        }
    }
}
