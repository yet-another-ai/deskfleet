//! Installation-wide settings and explicit operator-managed administrator grants.
use crate::{
    ControlStore, Error, Result, json_rows, name, now_ms, one,
    policies::{SiteAction, SitePolicy, authorize},
    sql,
};
use deskfleet_protocol::control::SiteSettings;
use sea_orm::{ConnectionTrait, QueryResult, TransactionTrait};
use serde_json::{Value, json};

fn settings(row: &QueryResult) -> Result<SiteSettings> {
    Ok(SiteSettings {
        site_name: row.try_get("", "site_name")?,
        announcement: row.try_get("", "announcement")?,
        allow_team_creation: row.try_get("", "allow_team_creation")?,
    })
}

impl ControlStore {
    /// Look up the current grant instead of caching it in login sessions.
    pub async fn is_site_admin(&self, user_id: &str) -> Result<bool> {
        Ok(self
            .db
            .query_one_raw(sql(
                "SELECT user_id FROM cp_site_admins WHERE user_id=$1",
                vec![user_id.into()],
            ))
            .await?
            .is_some())
    }

    /// Safe public settings; no credentials or deployment configuration live here.
    pub async fn site_settings(&self) -> Result<SiteSettings> {
        settings(
            &one(
                &self.db,
                "SELECT * FROM cp_site_settings WHERE singleton",
                vec![],
            )
            .await?,
        )
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
        let is_admin = tx
            .query_one_raw(sql(
                "SELECT user_id FROM cp_site_admins WHERE user_id=$1 FOR SHARE",
                vec![user_id.into()],
            ))
            .await?
            .is_some();
        authorize(&SitePolicy::new(is_admin), SiteAction::UpdateSettings)?;
        let site_name = name(&input.site_name)?;
        if input.announcement.len() > 10_000 {
            return Err(Error::Invalid(
                "announcement must contain at most 10000 bytes",
            ));
        }
        let before = settings(
            &one(
                &tx,
                "SELECT * FROM cp_site_settings WHERE singleton FOR UPDATE",
                vec![],
            )
            .await?,
        )?;
        let after = SiteSettings {
            site_name: site_name.into(),
            announcement: input.announcement.clone(),
            allow_team_creation: input.allow_team_creation,
        };
        tx.execute_raw(sql(
            "UPDATE cp_site_settings SET site_name=$1, announcement=$2, allow_team_creation=$3 WHERE singleton",
            vec![site_name.into(), input.announcement.clone().into(), input.allow_team_creation.into()],
        ))
        .await?;
        tx.execute_raw(sql(
            "INSERT INTO cp_site_audit(actor_user_id, source, action, before_value, after_value, occurred_at) VALUES($1, 'user', 'settings.update', $2, $3, $4)",
            vec![user_id.into(), json!(before).into(), json!(after).into(), now_ms().into()],
        ))
        .await?;
        tx.commit().await?;
        Ok(after)
    }

    /// Operator-only listing for the server CLI, not an authenticated API.
    pub async fn site_admins(&self) -> Result<Vec<Value>> {
        json_rows(
            &self.db,
            "SELECT jsonb_build_object('userId', u.id, 'name', u.name, 'email', u.email, 'grantedAt', a.granted_at, 'source', a.source) AS record FROM cp_site_admins a JOIN cp_users u ON u.id=a.user_id ORDER BY a.granted_at, a.user_id",
            vec![],
        )
        .await
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
        one(
            &tx,
            // Serialize operator changes while permitting audit foreign keys
            // to acquire KEY SHARE during an in-flight settings update.
            "SELECT id FROM cp_users WHERE id=$1 FOR NO KEY UPDATE",
            vec![user_id.into()],
        )
        .await?;
        let changed = if grant {
            tx.execute_raw(sql(
                "INSERT INTO cp_site_admins(user_id, granted_at, source) VALUES($1, $2, 'cli') ON CONFLICT(user_id) DO NOTHING",
                vec![user_id.into(), now_ms().into()],
            ))
            .await?
        } else {
            tx.execute_raw(sql(
                "DELETE FROM cp_site_admins WHERE user_id=$1",
                vec![user_id.into()],
            ))
            .await?
        }
        .rows_affected()
            > 0;
        if changed {
            tx.execute_raw(sql(
                "INSERT INTO cp_site_audit(source, action, target_user_id, before_value, after_value, occurred_at) VALUES('cli', $1, $2, $3, $4, $5)",
                vec![
                    (if grant { "admin.grant" } else { "admin.revoke" }).into(),
                    user_id.into(),
                    json!({"siteAdmin": !grant}).into(),
                    json!({"siteAdmin": grant}).into(),
                    now_ms().into(),
                ],
            ))
            .await?;
        }
        tx.commit().await?;
        Ok(changed)
    }
}
