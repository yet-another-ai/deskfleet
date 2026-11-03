//! Installation-wide settings and explicit operator-managed administrator grants.
use crate::entities::{
    cp_site_admins as admins, cp_site_audit as audit, cp_site_settings as site, cp_users as users,
};
use crate::{
    ControlStore, Error, Result, name, now_ms,
    policies::{SiteAction, SitePolicy, authorize},
};
use deskfleet_protocol::control::SiteSettings;
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
    }
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
    /// Replace all runtime settings and record their previous and new values.
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
    use super::terms_url;

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
