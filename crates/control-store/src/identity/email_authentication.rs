//! Short-lived mailbox proofs bound to one existing login session.
use crate::entities::{
    cp_identity_challenges as challenges, cp_login_sessions as sessions, cp_users as users,
};
use crate::{ControlStore, Error, Result, now_ms, secret, secret_hash};
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{Expr, ExprTrait, Query};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect, Set, TransactionTrait,
};
use serde_json::json;

fn code() -> String {
    loop {
        let random = uuid::Uuid::new_v4().as_fields().0;
        // Rejection sampling keeps all six-digit codes equally likely.
        if random < 4_294_000_000 {
            return format!("{:06}", random % 1_000_000);
        }
    }
}

impl ControlStore {
    /// Returns the challenge id, delivery code, and verified recipient address.
    pub async fn issue_email_authentication(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<(String, String, String)> {
        let tx = self.db.begin().await?;
        let user = users::Entity::find_by_id(user_id)
            .filter(users::Column::EmailVerified.eq(true))
            .filter(users::Column::Disabled.eq(false))
            .lock_exclusive()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
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
            .ok_or(Error::NotFound)?;
        let email = user.email;
        let version = user.credential_version;
        let challenge = secret();
        let code = code();
        let record = json!({"sessionId":session_id,"version":version,"codeHash":secret_hash(&format!("{challenge}:{code}")),"attempts":0});
        challenges::Entity::delete_many()
            .filter(challenges::Column::UserId.eq(user_id))
            .filter(challenges::Column::Purpose.eq("email_reauthentication"))
            .filter(
                Expr::col(challenges::Column::Record)
                    .cast_json_field("sessionId")
                    .eq(session_id),
            )
            .exec(&tx)
            .await?;
        challenges::Entity::insert(challenges::ActiveModel {
            token_hash: Set(secret_hash(&challenge)),
            purpose: Set("email_reauthentication".into()),
            user_id: Set(Some(user_id.into())),
            email: Set(email.clone()),
            record: Set(record),
            expires_at: Set(now_ms() + 600_000),
        })
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok((challenge, code, email))
    }

    /// Checks and consumes the proof in the same transaction that refreshes the session.
    pub async fn verify_email_authentication(
        &self,
        user_id: &str,
        session_id: &str,
        challenge: &str,
        code: &str,
    ) -> Result<()> {
        let tx = self.db.begin().await?;
        users::Entity::find_by_id(user_id)
            .filter(users::Column::EmailVerified.eq(true))
            .filter(users::Column::Disabled.eq(false))
            .lock_exclusive()
            .select_only()
            .column(users::Column::Id)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        let token_hash = secret_hash(challenge);
        let row = challenges::Entity::find_by_id(&token_hash)
            .filter(challenges::Column::Purpose.eq("email_reauthentication"))
            .filter(challenges::Column::UserId.eq(user_id))
            .filter(
                Expr::col(challenges::Column::Record)
                    .cast_json_field("sessionId")
                    .eq(session_id),
            )
            .filter(challenges::Column::ExpiresAt.gt(now_ms()))
            .lock_exclusive()
            .one(&tx)
            .await?
            .ok_or(Error::Unauthorized)?;
        let mut record = row.record;
        let attempts = record["attempts"].as_u64().ok_or(Error::Unauthorized)?;
        if attempts >= 5 {
            return Err(Error::Unauthorized);
        }
        if record["codeHash"] != secret_hash(&format!("{challenge}:{code}")) {
            record["attempts"] = json!(attempts + 1);
            challenges::Entity::update_many()
                .col_expr(challenges::Column::Record, Expr::val(record))
                .filter(challenges::Column::TokenHash.eq(token_hash))
                .exec(&tx)
                .await?;
            tx.commit().await?;
            return Err(Error::Unauthorized);
        }
        let version = record["version"].as_i64().ok_or(Error::Unauthorized)?;
        let now = now_ms();
        let updated = tx
            .execute(
                Query::update()
                    .table(sessions::Entity)
                    .value(sessions::Column::AuthenticatedAt, now)
                    .from(users::Entity)
                    .and_where(Expr::col((sessions::Entity, sessions::Column::Id)).eq(session_id))
                    .and_where(sessions::Column::UserId.eq(user_id))
                    .and_where(
                        Expr::col((users::Entity, users::Column::Id))
                            .eq(Expr::col((sessions::Entity, sessions::Column::UserId))),
                    )
                    .and_where(users::Column::CredentialVersion.eq(version))
                    .and_where(users::Column::Email.eq(row.email))
                    .and_where(users::Column::EmailVerified.eq(true))
                    .and_where(users::Column::Disabled.eq(false))
                    .and_where(sessions::Column::Revoked.eq(false))
                    .and_where(sessions::Column::ExpiresAt.gt(now)),
            )
            .await?;
        if updated.rows_affected() != 1 {
            return Err(Error::Unauthorized);
        }
        challenges::Entity::delete_by_id(token_hash)
            .exec(&tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}
