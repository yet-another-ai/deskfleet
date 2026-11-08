//! Verified account identity; authentication credentials never identify Teams.
mod challenges;
mod credentials;
mod deletion;
mod email_authentication;
mod maintenance;
mod oauth;
mod sessions;

use crate::entities::{
    cp_auth_limits, cp_passkeys, cp_registration_policy, cp_site_admins, cp_site_audit, cp_users,
};
use crate::{ControlStore, Error, Result, name, now_ms, one_query};
use deskfleet_protocol::control::User;
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{Alias, Expr, ExprTrait, Func, OnConflict, Query};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set,
    TransactionTrait,
};
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
fn user(row: &cp_users::Model) -> User {
    User {
        id: row.id.clone(),
        name: row.name.clone(),
        email: Some(row.email.clone()),
    }
}

// Serialize OAuth starts with credential mutations across replicas; sequence
// allocation must follow commit order for revocations to fence earlier starts.
async fn lock_authentication_generation(db: &impl ConnectionTrait) -> Result<()> {
    db.execute(
        Query::select().expr(Func::cust(Alias::new("pg_advisory_xact_lock")).arg(761946023_i64)),
    )
    .await?;
    Ok(())
}

fn next_authentication_generation() -> Expr {
    Func::cust(Alias::new("nextval"))
        .arg("cp_authentication_generation")
        .into()
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
        let inserted = cp_users::Entity::insert(cp_users::ActiveModel {
            id: Set(uuid::Uuid::now_v7().to_string()),
            name: Set(name(display_name)?.into()),
            email: Set(email),
            email_verified: Set(true),
            password_hash: Set(Some(password_hash.into())),
            disabled: Set(false),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(cp_users::Column::Email)
                .do_nothing()
                .to_owned(),
        )
        .exec_with_returning_many(&tx)
        .await?
        .into_iter()
        .next();
        let Some(inserted) = inserted else {
            tx.commit().await?;
            return Ok(false);
        };
        let now = crate::now_ms();
        cp_site_admins::Entity::insert(cp_site_admins::ActiveModel {
            user_id: Set(inserted.id.clone()),
            granted_at: Set(now),
            source: Set("cli".into()),
            ..Default::default()
        })
        .exec_without_returning(&tx)
        .await?;
        cp_site_audit::Entity::insert(cp_site_audit::ActiveModel {
            source: Set("cli".into()),
            action: Set("admin.grant".into()),
            target_user_id: Set(Some(inserted.id)),
            before_value: Set(json!({"siteAdmin":false})),
            after_value: Set(json!({"siteAdmin":true})),
            occurred_at: Set(now),
            ..Default::default()
        })
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Provision a mailbox-verified identity; HTTP callers use verify_registration.
    pub async fn verified_user(&self, email: &str, display_name: &str) -> Result<User> {
        let email = normalize_email(email)?;
        let row = cp_users::Entity::insert(cp_users::ActiveModel {
            id: Set(uuid::Uuid::now_v7().to_string()),
            name: Set(name(display_name)?.into()),
            email: Set(email),
            email_verified: Set(true),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(cp_users::Column::Email)
                .update_column(cp_users::Column::Name)
                .to_owned(),
        )
        .exec_with_returning(&self.db)
        .await?;
        Ok(user(&row))
    }
    /// Provision a verified password account. The caller supplies an already
    /// validated password hash; the audit record never contains credentials.
    pub async fn create_account(
        &self,
        actor: &str,
        email: &str,
        display_name: &str,
        password_hash: &str,
    ) -> Result<User> {
        let email = normalize_email(email)?;
        let display_name = name(display_name)?;
        let tx = self.db.begin().await?;
        cp_site_admins::Entity::find_by_id(actor)
            .lock_shared()
            .select_only()
            .column(cp_site_admins::Column::UserId)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::Forbidden)?;
        let row = cp_users::Entity::insert(cp_users::ActiveModel {
            id: Set(uuid::Uuid::now_v7().to_string()),
            name: Set(display_name.into()),
            email: Set(email.clone()),
            email_verified: Set(true),
            password_hash: Set(Some(password_hash.into())),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(cp_users::Column::Email)
                .do_nothing()
                .to_owned(),
        )
        .exec_with_returning_many(&tx)
        .await?
        .into_iter()
        .next()
        .ok_or(Error::Conflict("email address is already registered"))?;
        cp_site_audit::Entity::insert(cp_site_audit::ActiveModel {
            actor_user_id: Set(Some(actor.into())),
            source: Set("user".into()),
            action: Set("account.create".into()),
            target_user_id: Set(Some(row.id.clone())),
            before_value: Set(json!({"email":email})),
            after_value: Set(json!({"userId":row.id,"email":email})),
            occurred_at: Set(now_ms()),
            ..Default::default()
        })
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(user(&row))
    }
    pub async fn account(&self, id: &str) -> Result<User> {
        let row = cp_users::Entity::find_by_id(id)
            .filter(cp_users::Column::Disabled.eq(false))
            .filter(cp_users::Column::EmailVerified.eq(true))
            .one(&self.db)
            .await?
            .ok_or(Error::NotFound)?;
        Ok(user(&row))
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
    pub async fn authentication_methods(&self, user_id: &str) -> Result<Value> {
        let passkey = Query::select()
            .expr(Expr::val(1))
            .from(cp_passkeys::Entity)
            .and_where(
                Expr::col((cp_passkeys::Entity, cp_passkeys::Column::UserId))
                    .eq(Expr::col((cp_users::Entity, cp_users::Column::Id))),
            )
            .to_owned();
        let row = one_query(
            &self.db,
            Query::select()
                .expr_as(
                    Expr::col(cp_users::Column::PasswordHash).is_not_null(),
                    Alias::new("password"),
                )
                .expr_as(Expr::exists(passkey), Alias::new("passkey"))
                .from(cp_users::Entity)
                .and_where(cp_users::Column::Id.eq(user_id)),
        )
        .await?;
        Ok(
            json!({"password":row.try_get::<bool>("","password")?,"passkey":row.try_get::<bool>("","passkey")?}),
        )
    }
    pub async fn password_credentials(&self, email: &str) -> Result<Option<Value>> {
        Ok(cp_users::Entity::find().filter(cp_users::Column::Email.eq(normalize_email(email)?))
            .filter(cp_users::Column::EmailVerified.eq(true)).filter(cp_users::Column::Disabled.eq(false))
            .one(&self.db).await?.map(|row| json!({"userId":row.id,"passwordHash":row.password_hash,"version":row.credential_version})))
    }
    pub async fn registration_enabled(&self) -> Result<bool> {
        Ok(cp_registration_policy::Entity::find_by_id(true)
            .one(&self.db)
            .await?
            .ok_or(Error::NotFound)?
            .enabled)
    }
    pub async fn set_registration_enabled(&self, actor: &str, enabled: bool) -> Result<()> {
        let tx = self.db.begin().await?;
        cp_site_admins::Entity::find_by_id(actor)
            .lock_shared()
            .one(&tx)
            .await?
            .ok_or(Error::Forbidden)?;
        let previous = cp_registration_policy::Entity::find_by_id(true)
            .lock_exclusive()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?
            .enabled;
        cp_registration_policy::Entity::update_many()
            .col_expr(
                cp_registration_policy::Column::Enabled,
                Expr::value(enabled),
            )
            .filter(cp_registration_policy::Column::Singleton.eq(true))
            .exec(&tx)
            .await?;
        cp_site_audit::Entity::insert(cp_site_audit::ActiveModel {
            actor_user_id: Set(Some(actor.into())),
            source: Set("user".into()),
            action: Set("registration.update".into()),
            before_value: Set(json!({"enabled":previous})),
            after_value: Set(json!({"enabled":enabled})),
            occurred_at: Set(crate::now_ms()),
            ..Default::default()
        })
        .exec_without_returning(&tx)
        .await?;
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
        let query = query.trim();
        let grams =
            |expr: Expr| Expr::from(Func::cust(Alias::new("cp_account_search_grams")).arg(expr));
        let contains = |column| {
            Expr::from(Func::cust(Alias::new("strpos")).args([
                Func::lower(Expr::col(column)).into(),
                Func::lower(Expr::val(query)).into(),
            ]))
            .gt(0)
        };
        Ok(cp_users::Entity::find()
            .filter(grams(Expr::col(cp_users::Column::Name)).concat(grams(Expr::col(cp_users::Column::Email))).contains(grams(Expr::val(query))))
            .filter(contains(cp_users::Column::Email).or(contains(cp_users::Column::Name)))
            .filter(cp_users::Column::DeletedAt.is_null())
            .order_by_asc(cp_users::Column::Email).limit(50).all(&self.db).await?.into_iter()
            .map(|row| json!({"id":row.id,"name":row.name,"email":row.email,"disabled":row.disabled})).collect())
    }
    /// Database-backed fixed windows also bound attempts across server replicas.
    pub async fn auth_rate_limit(&self, key: &str, limit: i32, window_ms: i64) -> Result<bool> {
        let period = crate::now_ms() / window_ms * window_ms;
        let row = cp_auth_limits::Entity::insert(cp_auth_limits::ActiveModel {
            key_hash: Set(crate::secret_hash(key)),
            period: Set(period),
            requests: Set(1),
        })
        .on_conflict(
            OnConflict::columns([
                cp_auth_limits::Column::KeyHash,
                cp_auth_limits::Column::Period,
            ])
            .value(
                cp_auth_limits::Column::Requests,
                Expr::col((cp_auth_limits::Entity, cp_auth_limits::Column::Requests)).add(1),
            )
            .to_owned(),
        )
        .exec_with_returning(&self.db)
        .await?;
        Ok(row.requests <= limit)
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
