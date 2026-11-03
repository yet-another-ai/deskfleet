//! Provider subjects identify accounts independently of their current email address.
use super::{normalize_email, user};
use crate::entities::{
    cp_github_identities as github, cp_google_identities as google,
    cp_registration_policy as policy, cp_site_settings as settings, cp_users as users,
};
use crate::{ControlStore, Error, Result, name};
use deskfleet_protocol::control::User;
use sea_orm::sea_query::{Alias, Expr, Func, OnConflict, Query};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect, Set, TransactionTrait,
};

#[derive(Clone, Copy)]
enum Provider {
    Github,
    Google,
}

impl Provider {
    fn user_query(self, subject: &str) -> sea_orm::Select<users::Entity> {
        let identity = match self {
            Self::Github => Query::select()
                .column(github::Column::UserId)
                .from(github::Entity)
                .and_where(github::Column::Subject.eq(subject))
                .to_owned(),
            Self::Google => Query::select()
                .column(google::Column::UserId)
                .from(google::Entity)
                .and_where(google::Column::Subject.eq(subject))
                .to_owned(),
        };
        users::Entity::find().filter(users::Column::Id.in_subquery(identity))
    }
}

impl ControlStore {
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
        let row = provider
            .user_query(subject)
            .filter(users::Column::Disabled.eq(false))
            .filter(users::Column::EmailVerified.eq(true))
            .one(&self.db)
            .await?
            .ok_or(Error::NotFound)?;
        Ok(user(&row))
    }
    async fn oauth_user(
        &self,
        provider: Provider,
        subject: &str,
        email: &str,
        display_name: &str,
        accepted_terms: bool,
    ) -> Result<User> {
        let tx = self.db.begin().await?;
        tx.execute(
            Query::select().expr(
                Func::cust(Alias::new("pg_advisory_xact_lock")).arg(
                    Func::cust(Alias::new("hashtextextended"))
                        .args([Expr::val(subject), Expr::val(761946022_i64)]),
                ),
            ),
        )
        .await?;
        if let Some(row) = provider.user_query(subject).one(&tx).await? {
            if row.disabled || !row.email_verified {
                return Err(Error::Unauthorized);
            }
            return Ok(user(&row));
        }
        let enabled = policy::Entity::find_by_id(true)
            .lock_shared()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?
            .enabled;
        if !enabled {
            return Err(Error::Invalid("registration disabled"));
        }
        let settings = settings::Entity::find_by_id(true)
            .lock_shared()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        if !accepted_terms
            && (!settings.terms_of_service_url.is_empty() || !settings.privacy_terms_url.is_empty())
        {
            return Err(Error::Invalid("terms acceptance required"));
        }
        let email = normalize_email(email)?;
        let inserted = users::Entity::insert(users::ActiveModel {
            id: Set(uuid::Uuid::now_v7().to_string()),
            name: Set(name(display_name)?.into()),
            email: Set(email),
            email_verified: Set(true),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(users::Column::Email)
                .do_nothing()
                .to_owned(),
        )
        .exec_with_returning_many(&tx)
        .await?
        .into_iter()
        .next();
        let Some(row) = inserted else {
            return Err(Error::Conflict("account already exists"));
        };
        let account = user(&row);
        match provider {
            Provider::Github => {
                github::Entity::insert(github::ActiveModel {
                    subject: Set(subject.into()),
                    user_id: Set(account.id.clone()),
                })
                .exec_without_returning(&tx)
                .await?;
            }
            Provider::Google => {
                google::Entity::insert(google::ActiveModel {
                    subject: Set(subject.into()),
                    user_id: Set(account.id.clone()),
                })
                .exec_without_returning(&tx)
                .await?;
            }
        }
        tx.commit().await?;
        Ok(account)
    }
}
