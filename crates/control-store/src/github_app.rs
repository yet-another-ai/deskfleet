//! Per-user GitHub App grants. Tokens stay in central storage, never in client settings.
use crate::entities::{
    cp_github_app_authorizations as grants, cp_login_sessions as sessions, cp_users as users,
};
use crate::{ControlStore, Error, Result, now_ms};
use sea_orm::sea_query::{Cond, Expr, Func, OnConflict};
use sea_orm::{
    ColumnTrait, DatabaseTransaction, EntityTrait, QueryFilter, QuerySelect, Set, TransactionTrait,
};
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
            grants::Entity::update_many()
                .col_expr(
                    grants::Column::AccessToken,
                    Expr::val(tokens.access_token.clone()),
                )
                .col_expr(grants::Column::ExpiresAt, Expr::val(tokens.expires_at))
                .col_expr(
                    grants::Column::RefreshToken,
                    Expr::val(tokens.refresh_token.clone()),
                )
                .col_expr(
                    grants::Column::RefreshExpiresAt,
                    Expr::val(tokens.refresh_expires_at),
                )
                .filter(grants::Column::UserId.eq(self.user_id))
                .exec(&self.tx)
                .await?;
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
        let row = grants::Entity::find_by_id(user_id)
            .filter(grants::Column::ClientId.eq(client_id))
            .filter(grants::Column::ActAsYou.eq(true))
            .lock_exclusive()
            .one(&tx)
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        Ok(Some(GithubAppAccess {
            tokens: GithubAppTokens {
                access_token: row.access_token,
                expires_at: row.expires_at,
                refresh_token: row.refresh_token,
                refresh_expires_at: row.refresh_expires_at,
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
        let now = now_ms();
        let row = grants::Entity::find_by_id(user_id)
            .filter(grants::Column::ClientId.eq(client_id))
            .one(&self.db)
            .await?;
        let Some(row) = row else {
            return Ok(GithubAppStatus::default());
        };
        let authorized = row.expires_at.is_none_or(|expiry| expiry > now)
            || (row.refresh_token.is_some()
                && row.refresh_expires_at.is_some_and(|expiry| expiry > now));
        Ok(GithubAppStatus {
            authorized,
            login: Some(row.login),
            act_as_you: authorized && row.act_as_you,
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
        users::Entity::find_by_id(user_id)
            .filter(users::Column::Disabled.eq(false))
            .filter(users::Column::EmailVerified.eq(true))
            .lock_shared()
            .select_only()
            .column(users::Column::Id)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::Unauthorized)?;
        sessions::Entity::find_by_id(session_id)
            .filter(sessions::Column::UserId.eq(user_id))
            .filter(sessions::Column::Revoked.eq(false))
            .filter(sessions::Column::ExpiresAt.gt(now_ms()))
            .lock_shared()
            .select_only()
            .column(sessions::Column::Id)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::Unauthorized)?;
        grants::Entity::insert(grants::ActiveModel {
            user_id: Set(user_id.into()),
            client_id: Set(client_id.into()),
            subject: Set(grant.subject),
            login: Set(grant.login),
            access_token: Set(grant.access_token),
            expires_at: Set(grant.expires_at),
            refresh_token: Set(grant.refresh_token),
            refresh_expires_at: Set(grant.refresh_expires_at),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(grants::Column::UserId)
                .update_columns([
                    grants::Column::ClientId,
                    grants::Column::Subject,
                    grants::Column::Login,
                    grants::Column::AccessToken,
                    grants::Column::ExpiresAt,
                    grants::Column::RefreshToken,
                    grants::Column::RefreshExpiresAt,
                ])
                .value(grants::Column::ActAsYou, false)
                .to_owned(),
        )
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn set_github_act_as_you(
        &self,
        user_id: &str,
        client_id: &str,
        enabled: bool,
    ) -> Result<()> {
        let now = now_ms();
        let mut query = grants::Entity::update_many()
            .col_expr(grants::Column::ActAsYou, Expr::val(enabled))
            .filter(grants::Column::UserId.eq(user_id))
            .filter(grants::Column::ClientId.eq(client_id));
        if enabled {
            query = query.filter(
                Cond::any()
                    .add(grants::Column::ExpiresAt.is_null())
                    .add(grants::Column::ExpiresAt.gt(now))
                    .add(
                        Cond::all()
                            .add(grants::Column::RefreshToken.is_not_null())
                            .add(Expr::from(Func::coalesce([
                                grants::Column::RefreshExpiresAt.gt(now),
                                Expr::val(false),
                            ]))),
                    ),
            );
        }
        let result = query.exec(&self.db).await?;
        if enabled && result.rows_affected == 0 {
            return Err(Error::Invalid("GitHub App authorization is required"));
        }
        Ok(())
    }
}
