use crate::entities::{cp_identity_challenges as challenges, cp_users as users};
use crate::{ControlStore, Error, Result, name, now_ms, secret, secret_hash};
use sea_orm::sea_query::OnConflict;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, Set, TransactionTrait};
use serde_json::{Value, json};

impl ControlStore {
    pub async fn issue_identity_challenge(
        &self,
        purpose: &str,
        user_id: Option<&str>,
        email: &str,
        record: Value,
        lifetime_ms: i64,
    ) -> Result<String> {
        let token = secret();
        challenges::Entity::insert(challenges::ActiveModel {
            token_hash: Set(secret_hash(&token)),
            purpose: Set(purpose.into()),
            user_id: Set(user_id.map(str::to_owned)),
            email: Set(email.into()),
            record: Set(record),
            expires_at: Set(now_ms() + lifetime_ms),
        })
        .exec_without_returning(&self.db)
        .await?;
        Ok(token)
    }
    pub async fn consume_identity_challenge(&self, token: &str, purpose: &str) -> Result<Value> {
        let row = challenges::Entity::delete_many()
            .filter(challenges::Column::TokenHash.eq(secret_hash(token)))
            .filter(challenges::Column::Purpose.eq(purpose))
            .filter(challenges::Column::ExpiresAt.gt(now_ms()))
            .exec_with_returning(&self.db)
            .await?
            .into_iter()
            .next()
            .ok_or(Error::Unauthorized)?;
        Ok(json!({"userId":row.user_id,"email":row.email,"record":row.record}))
    }
    /// No password is accepted before this mailbox proof: a planted pending
    /// registration cannot attach the attacker's credentials to the mailbox owner.
    pub async fn verify_registration(
        &self,
        token: &str,
        display_name: &str,
        password_hash: &str,
    ) -> Result<deskfleet_protocol::control::User> {
        let tx = self.db.begin().await?;
        // Serialize registrations on the unique mailbox before locking proofs.
        // Otherwise two proofs for one mailbox can deadlock while one INSERT
        // waits for the other and the winner clears the loser's locked proof.
        let email = challenges::Entity::find_by_id(secret_hash(token))
            .filter(challenges::Column::Purpose.eq("registration"))
            .filter(challenges::Column::ExpiresAt.gt(now_ms()))
            .one(&tx)
            .await?
            .ok_or(Error::Unauthorized)?
            .email;
        let inserted = users::Entity::insert(users::ActiveModel {
            id: Set(uuid::Uuid::now_v7().to_string()),
            name: Set(name(display_name)?.into()),
            email: Set(email.clone()),
            email_verified: Set(true),
            password_hash: Set(Some(password_hash.into())),
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
            return Err(Error::Conflict(
                "account already exists; sign in or recover your password",
            ));
        };
        // Recheck expiry and one-time use after any mailbox lock wait. A lost
        // proof rolls back the account insertion in this same transaction.
        challenges::Entity::delete_many()
            .filter(challenges::Column::TokenHash.eq(secret_hash(token)))
            .filter(challenges::Column::Purpose.eq("registration"))
            .filter(challenges::Column::ExpiresAt.gt(now_ms()))
            .exec_with_returning(&tx)
            .await?
            .into_iter()
            .next()
            .ok_or(Error::Unauthorized)?;
        challenges::Entity::delete_many()
            .filter(challenges::Column::Email.eq(email))
            .filter(challenges::Column::Purpose.eq("registration"))
            .exec(&tx)
            .await?;
        let user = super::user(&row);
        tx.commit().await?;
        Ok(user)
    }
}
