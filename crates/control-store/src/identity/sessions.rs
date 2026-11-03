use crate::entities::{
    cp_identity_challenges as challenges, cp_login_attempts as attempts, cp_login_codes as codes,
    cp_login_sessions as sessions, cp_peers as peers, cp_users as users,
};
use crate::{
    AuthSession, ControlStore, Error, Result, now_ms, one_query, secret, secret_hash, timestamp,
};
use deskfleet_protocol::control::{PeerAuthorization, User};
use sea_orm::sea_query::{Alias, Expr, ExprTrait, JoinType, Query};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set,
    TransactionTrait,
};
use serde_json::{Value, json};

impl ControlStore {
    pub async fn new_session(&self, user_id: &str) -> Result<Value> {
        self.new_session_at_version(user_id, None).await
    }
    pub async fn new_session_at_version(
        &self,
        user_id: &str,
        version: Option<i64>,
    ) -> Result<Value> {
        self.new_session_checked(user_id, version, None).await
    }
    /// Establish an OAuth session only if no credential revocation followed its start.
    pub async fn new_session_at_generation(&self, user_id: &str, generation: i64) -> Result<Value> {
        self.new_session_checked(user_id, None, Some(generation))
            .await
    }
    pub async fn authentication_generation(&self) -> Result<i64> {
        let tx = self.db.begin().await?;
        super::lock_authentication_generation(&tx).await?;
        let generation = one_query(
            &tx,
            Query::select().expr_as(
                super::next_authentication_generation(),
                Alias::new("generation"),
            ),
        )
        .await?
        .try_get("", "generation")?;
        tx.commit().await?;
        Ok(generation)
    }
    async fn new_session_checked(
        &self,
        user_id: &str,
        version: Option<i64>,
        generation: Option<i64>,
    ) -> Result<Value> {
        let tx = self.db.begin().await?;
        let row = users::Entity::find_by_id(user_id)
            .filter(users::Column::Disabled.eq(false))
            .filter(users::Column::EmailVerified.eq(true))
            .lock_shared()
            .one(&tx)
            .await?
            .ok_or(Error::Unauthorized)?;
        if version.is_some_and(|v| row.credential_version != v)
            || generation.is_some_and(|v| row.authentication_generation > v)
        {
            return Err(Error::Unauthorized);
        }
        let token = secret();
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let expires = now + 30 * 24 * 60 * 60 * 1000;
        sessions::Entity::insert(sessions::ActiveModel {
            id: Set(id.clone()),
            user_id: Set(user_id.into()),
            device_id: Set(id.clone()),
            token_hash: Set(secret_hash(&token)),
            created_at: Set(now),
            authenticated_at: Set(now),
            expires_at: Set(expires),
            ..Default::default()
        })
        .exec_without_returning(&tx)
        .await?;
        let user = super::user(&row);
        tx.commit().await?;
        Ok(json!({"token":token,"user":user,"sessionId":id,"expiresAt":timestamp(expires)}))
    }
    pub async fn authenticate(&self, token: &str) -> Result<AuthSession> {
        let row = self
            .db
            .query_one(
                active_session_query()
                    .columns([
                        (sessions::Entity, sessions::Column::Id),
                        (sessions::Entity, sessions::Column::DeviceId),
                    ])
                    .expr_as(
                        Expr::col((users::Entity, users::Column::Id)),
                        Alias::new("user_id"),
                    )
                    .columns([
                        (users::Entity, users::Column::Name),
                        (users::Entity, users::Column::Email),
                    ])
                    .and_where(sessions::Column::TokenHash.eq(secret_hash(token))),
            )
            .await?
            .ok_or(Error::Unauthorized)?;
        Ok(AuthSession {
            id: row.try_get("", "id")?,
            device_id: row.try_get("", "device_id")?,
            user: User {
                id: row.try_get("", "user_id")?,
                name: row.try_get("", "name")?,
                email: row.try_get("", "email")?,
            },
        })
    }
    pub async fn session_is_active(&self, id: &str) -> Result<bool> {
        Ok(self
            .db
            .query_one(
                active_session_query()
                    .column((sessions::Entity, sessions::Column::Id))
                    .and_where(Expr::col((sessions::Entity, sessions::Column::Id)).eq(id)),
            )
            .await?
            .is_some())
    }
    pub async fn recent_authentication(&self, id: &str) -> Result<bool> {
        Ok(sessions::Entity::find_by_id(id)
            .filter(sessions::Column::Revoked.eq(false))
            .filter(sessions::Column::ExpiresAt.gt(now_ms()))
            .filter(sessions::Column::AuthenticatedAt.gt(now_ms() - 600_000))
            .one(&self.db)
            .await?
            .is_some())
    }
    pub async fn refresh_authentication(&self, id: &str, version: i64) -> Result<()> {
        let now = now_ms();
        let result = self
            .db
            .execute(
                Query::update()
                    .table(sessions::Entity)
                    .value(sessions::Column::AuthenticatedAt, now)
                    .from(users::Entity)
                    .and_where(Expr::col((sessions::Entity, sessions::Column::Id)).eq(id))
                    .and_where(
                        Expr::col((users::Entity, users::Column::Id))
                            .eq(Expr::col((sessions::Entity, sessions::Column::UserId))),
                    )
                    .and_where(users::Column::Disabled.eq(false))
                    .and_where(users::Column::CredentialVersion.eq(version))
                    .and_where(sessions::Column::Revoked.eq(false))
                    .and_where(sessions::Column::ExpiresAt.gt(now)),
            )
            .await?;
        if result.rows_affected() != 1 {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }
    pub async fn login_sessions(&self, user_id: &str, current: &str) -> Result<Vec<Value>> {
        Ok(sessions::Entity::find().filter(sessions::Column::UserId.eq(user_id)).filter(sessions::Column::Revoked.eq(false))
            .filter(sessions::Column::ExpiresAt.gt(now_ms())).order_by_desc(sessions::Column::CreatedAt).all(&self.db).await?
            .into_iter().map(|row| json!({"current":row.id==current,"id":row.id,"deviceId":row.device_id,"createdAt":timestamp(row.created_at),"expiresAt":timestamp(row.expires_at)})).collect())
    }
    pub async fn logout(&self, id: &str) -> Result<()> {
        sessions::Entity::update_many()
            .col_expr(sessions::Column::Revoked, Expr::val(true))
            .filter(sessions::Column::Id.eq(id))
            .exec(&self.db)
            .await?;
        Ok(())
    }
    pub async fn revoke_user_sessions(
        &self,
        user_id: &str,
        session_id: Option<&str>,
    ) -> Result<Vec<PeerAuthorization>> {
        let tx = self.db.begin().await?;
        if session_id.is_none() {
            super::lock_authentication_generation(&tx).await?;
        }
        users::Entity::find_by_id(user_id)
            .lock_exclusive()
            .select_only()
            .column(users::Column::Id)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        let mut update = sessions::Entity::update_many()
            .col_expr(sessions::Column::Revoked, Expr::val(true))
            .filter(sessions::Column::UserId.eq(user_id))
            .filter(sessions::Column::Revoked.eq(false));
        if let Some(id) = session_id {
            update = update.filter(sessions::Column::Id.eq(id));
        }
        update.exec(&tx).await?;
        if session_id.is_none() {
            // Outstanding native codes and login ceremonies must not recreate a
            // session after the owner has explicitly revoked every session.
            users::Entity::update_many()
                .col_expr(
                    users::Column::CredentialVersion,
                    Expr::col(users::Column::CredentialVersion).add(1),
                )
                .col_expr(
                    users::Column::AuthenticationGeneration,
                    super::next_authentication_generation(),
                )
                .filter(users::Column::Id.eq(user_id))
                .exec(&tx)
                .await?;
            codes::Entity::delete_many()
                .filter(codes::Column::UserId.eq(user_id))
                .exec(&tx)
                .await?;
            challenges::Entity::delete_many()
                .filter(challenges::Column::UserId.eq(user_id))
                .exec(&tx)
                .await?;
        }
        let mut update = peers::Entity::update_many()
            .col_expr(peers::Column::Revoked, Expr::val(true))
            .filter(peers::Column::UserId.eq(user_id))
            .filter(peers::Column::Revoked.eq(false));
        if let Some(id) = session_id {
            update = update.filter(peers::Column::LoginSessionId.eq(id));
        }
        let peers = update
            .exec_with_returning(&tx)
            .await?
            .into_iter()
            .map(|row| serde_json::from_value(row.grant_json))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        tx.commit().await?;
        Ok(peers)
    }
    pub async fn save_login_attempt(&self, state: &str, record: Value) -> Result<()> {
        attempts::Entity::insert(attempts::ActiveModel {
            state_hash: Set(secret_hash(state)),
            record: Set(record),
            expires_at: Set(now_ms() + 600_000),
        })
        .exec_without_returning(&self.db)
        .await?;
        Ok(())
    }
    pub async fn consume_login_attempt(&self, state: &str) -> Result<Value> {
        Ok(attempts::Entity::delete_many()
            .filter(attempts::Column::StateHash.eq(secret_hash(state)))
            .filter(attempts::Column::ExpiresAt.gt(now_ms()))
            .exec_with_returning(&self.db)
            .await?
            .into_iter()
            .next()
            .ok_or(Error::Unauthorized)?
            .record)
    }
    pub async fn new_login_code(&self, user_id: &str, verifier_hash: &str) -> Result<String> {
        let code = secret();
        let query = Query::select()
            .expr(Expr::val(secret_hash(&code)))
            .column(users::Column::Id)
            .expr(Expr::val(verifier_hash))
            .column(users::Column::CredentialVersion)
            .expr(Expr::val(now_ms() + 60_000))
            .from(users::Entity)
            .and_where(users::Column::Id.eq(user_id))
            .and_where(users::Column::Disabled.eq(false))
            .and_where(users::Column::EmailVerified.eq(true))
            .to_owned();
        let result = self
            .db
            .execute(
                Query::insert()
                    .into_table(codes::Entity)
                    .columns([
                        codes::Column::CodeHash,
                        codes::Column::UserId,
                        codes::Column::VerifierHash,
                        codes::Column::CredentialVersion,
                        codes::Column::ExpiresAt,
                    ])
                    .select_from(query)
                    .expect("login code insert has five selected columns"),
            )
            .await?;
        if result.rows_affected() != 1 {
            return Err(Error::Unauthorized);
        }
        Ok(code)
    }
    pub async fn new_login_code_for_session(
        &self,
        user_id: &str,
        session_id: &str,
        verifier_hash: &str,
    ) -> Result<String> {
        let tx = self.db.begin().await?;
        let row = users::Entity::find_by_id(user_id)
            .filter(users::Column::Disabled.eq(false))
            .filter(users::Column::EmailVerified.eq(true))
            .lock_exclusive()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        sessions::Entity::find_by_id(session_id)
            .filter(sessions::Column::UserId.eq(user_id))
            .filter(sessions::Column::Revoked.eq(false))
            .filter(sessions::Column::ExpiresAt.gt(now_ms()))
            .filter(sessions::Column::AuthenticatedAt.gt(now_ms() - 600_000))
            .lock_shared()
            .select_only()
            .column(sessions::Column::Id)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::Unauthorized)?;
        let code = secret();
        codes::Entity::insert(codes::ActiveModel {
            code_hash: Set(secret_hash(&code)),
            user_id: Set(user_id.into()),
            verifier_hash: Set(verifier_hash.into()),
            credential_version: Set(row.credential_version),
            expires_at: Set(now_ms() + 60_000),
        })
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(code)
    }
    pub async fn exchange_login_code(&self, code: &str, verifier: &str) -> Result<Value> {
        let row = codes::Entity::delete_many()
            .filter(codes::Column::CodeHash.eq(secret_hash(code)))
            .filter(codes::Column::ExpiresAt.gt(now_ms()))
            .filter(codes::Column::VerifierHash.eq(secret_hash(verifier)))
            .exec_with_returning(&self.db)
            .await?
            .into_iter()
            .next()
            .ok_or(Error::Unauthorized)?;
        self.new_session_at_version(&row.user_id, Some(row.credential_version))
            .await
    }
}

fn active_session_query() -> sea_orm::sea_query::SelectStatement {
    Query::select()
        .from(sessions::Entity)
        .join(
            JoinType::InnerJoin,
            users::Entity,
            Expr::col((users::Entity, users::Column::Id))
                .eq(Expr::col((sessions::Entity, sessions::Column::UserId))),
        )
        .and_where(sessions::Column::Revoked.eq(false))
        .and_where(sessions::Column::ExpiresAt.gt(now_ms()))
        .and_where(users::Column::Disabled.eq(false))
        .and_where(users::Column::EmailVerified.eq(true))
        .to_owned()
}
