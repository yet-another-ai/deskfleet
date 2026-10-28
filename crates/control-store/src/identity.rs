//! Verified account identity; authentication credentials never identify Teams.
mod challenges;
mod credentials;
mod maintenance;
mod sessions;

use crate::{ControlStore, Error, Result, name, one, sql};
use deskfleet_protocol::control::User;
use sea_orm::{ConnectionTrait, QueryResult, TransactionTrait};
use serde_json::{Value, json};

/// Matching policy shared by registration, recovery, email changes and invites.
pub fn normalize_email(value: &str) -> Result<String> {
    let email = value.trim().to_ascii_lowercase();
    let Some((local, domain)) = email.split_once('@') else {
        return Err(Error::Invalid("invalid email address"));
    };
    if email.len() > 254
        || local.is_empty()
        || local.len() > 64
        || domain.is_empty()
        || !email.is_ascii()
        || email
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        || domain.contains('@')
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
        || local.contains(['<', '>', '"', '\\'])
    {
        return Err(Error::Invalid("invalid email address"));
    }
    Ok(email)
}
fn user(row: &QueryResult) -> Result<User> {
    Ok(User {
        id: row.try_get("", "id")?,
        name: row.try_get("", "name")?,
        email: row.try_get("", "email")?,
    })
}
impl ControlStore {
    /// Create the explicitly requested development administrator once. An
    /// existing mailbox is never changed or granted additional privileges.
    pub async fn seed_development_admin(
        &self,
        email: &str,
        display_name: &str,
        password_hash: &str,
    ) -> Result<bool> {
        let email = normalize_email(email)?;
        let tx = self.db.begin().await?;
        let inserted = tx
            .query_one_raw(sql(
                "INSERT INTO cp_users(id,name,email,email_verified,password_hash,disabled) VALUES($1,$2,$3,TRUE,$4,FALSE) ON CONFLICT(email) DO NOTHING RETURNING id",
                vec![
                    uuid::Uuid::now_v7().to_string().into(),
                    name(display_name)?.into(),
                    email.into(),
                    password_hash.into(),
                ],
            ))
            .await?;
        let Some(inserted) = inserted else {
            tx.commit().await?;
            return Ok(false);
        };
        let user_id: String = inserted.try_get("", "id")?;
        let now = crate::now_ms();
        tx.execute_raw(sql(
            "INSERT INTO cp_site_admins(user_id,granted_at,source) VALUES($1,$2,'cli')",
            vec![user_id.clone().into(), now.into()],
        ))
        .await?;
        tx.execute_raw(sql(
            "INSERT INTO cp_site_audit(source,action,target_user_id,before_value,after_value,occurred_at) VALUES('cli','admin.grant',$1,$2,$3,$4)",
            vec![
                user_id.into(),
                json!({"siteAdmin":false}).into(),
                json!({"siteAdmin":true}).into(),
                now.into(),
            ],
        ))
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Provision a mailbox-verified identity; HTTP callers use verify_registration.
    pub async fn verified_user(&self, email: &str, display_name: &str) -> Result<User> {
        let email = normalize_email(email)?;
        user(&one(&self.db, "INSERT INTO cp_users(id,name,email,email_verified) VALUES($1,$2,$3,TRUE) ON CONFLICT(email) DO UPDATE SET name=excluded.name RETURNING id,name,email", vec![uuid::Uuid::now_v7().to_string().into(), name(display_name)?.into(), email.into()]).await?)
    }
    pub async fn account(&self, id: &str) -> Result<User> {
        user(&one(&self.db,"SELECT id,name,email FROM cp_users WHERE id=$1 AND NOT disabled AND email_verified",vec![id.into()]).await?)
    }
    pub async fn ensure_active_user(&self, id: &str) -> Result<()> {
        self.account(id).await.map(|_| ()).map_err(|e| {
            if matches!(e, Error::NotFound) {
                Error::Unauthorized
            } else {
                e
            }
        })
    }
    pub async fn password_credentials(&self, email: &str) -> Result<Option<Value>> {
        self.db.query_one_raw(sql("SELECT id,password_hash,credential_version FROM cp_users WHERE email=$1 AND email_verified AND NOT disabled",vec![normalize_email(email)?.into()])).await?.map(|row| -> Result<Value> { Ok(json!({"userId":row.try_get::<String>("","id")?,"passwordHash":row.try_get::<Option<String>>("","password_hash")?,"version":row.try_get::<i64>("","credential_version")?})) }).transpose()
    }
    pub async fn registration_enabled(&self) -> Result<bool> {
        Ok(one(
            &self.db,
            "SELECT enabled FROM cp_registration_policy WHERE singleton",
            vec![],
        )
        .await?
        .try_get("", "enabled")?)
    }
    pub async fn set_registration_enabled(&self, actor: &str, enabled: bool) -> Result<()> {
        let tx = self.db.begin().await?;
        one(
            &tx,
            "SELECT user_id FROM cp_site_admins WHERE user_id=$1 FOR SHARE",
            vec![actor.into()],
        )
        .await
        .map_err(|e| {
            if matches!(e, Error::NotFound) {
                Error::Forbidden
            } else {
                e
            }
        })?;
        let previous: bool = one(
            &tx,
            "SELECT enabled FROM cp_registration_policy WHERE singleton FOR UPDATE",
            vec![],
        )
        .await?
        .try_get("", "enabled")?;
        tx.execute_raw(sql(
            "UPDATE cp_registration_policy SET enabled=$1 WHERE singleton",
            vec![enabled.into()],
        ))
        .await?;
        tx.execute_raw(sql("INSERT INTO cp_site_audit(actor_user_id,source,action,before_value,after_value,occurred_at) VALUES($1,'user','registration.update',$2,$3,$4)",vec![actor.into(),json!({"enabled":previous}).into(),json!({"enabled":enabled}).into(),crate::now_ms().into()])).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn find_accounts(&self, actor: &str, query: &str) -> Result<Vec<Value>> {
        if !self.is_site_admin(actor).await? {
            return Err(Error::Forbidden);
        }
        if query.len() > 254 {
            return Err(Error::Invalid("search is too long"));
        }
        crate::json_rows(&self.db,"SELECT jsonb_build_object('id',id,'name',name,'email',email,'disabled',disabled) AS record FROM cp_users WHERE (cp_account_search_grams(name) || cp_account_search_grams(email)) @> cp_account_search_grams($1) AND (strpos(lower(email),lower($1))>0 OR strpos(lower(name),lower($1))>0) ORDER BY email LIMIT 50",vec![query.trim().into()]).await
    }
    /// Database-backed fixed windows also bound attempts across server replicas.
    pub async fn auth_rate_limit(&self, key: &str, limit: i32, window_ms: i64) -> Result<bool> {
        let period = crate::now_ms() / window_ms * window_ms;
        let count: i32 = one(&self.db,"INSERT INTO cp_auth_limits(key_hash,period,requests) VALUES($1,$2,1) ON CONFLICT(key_hash,period) DO UPDATE SET requests=cp_auth_limits.requests+1 RETURNING requests",vec![crate::secret_hash(key).into(),period.into()]).await?.try_get("","requests")?;
        Ok(count <= limit)
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn mailbox_matching_is_consistent() {
        assert_eq!(
            super::normalize_email(" User+tag@EXAMPLE.COM ").unwrap(),
            "user+tag@example.com"
        );
        for invalid in [
            "bad",
            "a@b@c.com",
            "a @example.com",
            "a@",
            "@example.com",
            "a\n@example.com",
        ] {
            assert!(super::normalize_email(invalid).is_err());
        }
    }
}
