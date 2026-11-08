use crate::entities::{
    cp_identity_challenges as challenges, cp_login_sessions as sessions, cp_passkeys as passkeys,
    cp_peers as peers, cp_site_admins as admins, cp_site_audit as audit, cp_users as users,
};
use crate::{ControlStore, Error, Result, name, now_ms, secret_hash};
use deskfleet_protocol::control::PeerAuthorization;
use sea_orm::sea_query::{Expr, ExprTrait};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set,
    TransactionTrait,
};
use serde_json::{Value, json};

impl ControlStore {
    /// Recovery proof, password replacement, session revocation and peer
    /// revocation commit together; registered Machines remain untouched.
    pub async fn recover_password(
        &self,
        token: &str,
        password_hash: &str,
    ) -> Result<(String, Vec<PeerAuthorization>)> {
        let tx = self.db.begin().await?;
        super::lock_authentication_generation(&tx).await?;
        // Discover the owner without locking the challenge, then serialize with
        // credential changes and revocation before consuming any child record.
        let user_id = challenges::Entity::find_by_id(secret_hash(token))
            .select_only()
            .column(challenges::Column::UserId)
            .filter(challenges::Column::Purpose.eq("recovery"))
            .filter(challenges::Column::ExpiresAt.gt(now_ms()))
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::Unauthorized)?;
        users::Entity::find_by_id(&user_id)
            .lock_exclusive()
            .select_only()
            .column(users::Column::Id)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        let challenge = challenges::Entity::delete_many()
            .filter(challenges::Column::TokenHash.eq(secret_hash(token)))
            .filter(challenges::Column::Purpose.eq("recovery"))
            .filter(challenges::Column::ExpiresAt.gt(now_ms()))
            .exec_with_returning(&tx)
            .await?
            .into_iter()
            .next()
            .ok_or(Error::Unauthorized)?;
        let version = challenge.record["version"]
            .as_i64()
            .ok_or(Error::Unauthorized)?;
        let updated = credential_mutation()
            .col_expr(users::Column::PasswordHash, Expr::val(password_hash))
            .filter(users::Column::Id.eq(&user_id))
            .filter(users::Column::Disabled.eq(false))
            .filter(users::Column::CredentialVersion.eq(version))
            .exec(&tx)
            .await?;
        if updated.rows_affected != 1 {
            return Err(Error::Unauthorized);
        }
        let peers = revoke(&tx, &user_id).await?;
        tx.commit().await?;
        Ok((user_id, peers))
    }
    pub async fn change_password(
        &self,
        user_id: &str,
        password_hash: &str,
        session_id: &str,
    ) -> Result<Vec<PeerAuthorization>> {
        let tx = self.db.begin().await?;
        super::lock_authentication_generation(&tx).await?;
        require_recent(&tx, user_id, session_id).await?;
        let updated = credential_mutation()
            .col_expr(users::Column::PasswordHash, Expr::val(password_hash))
            .filter(users::Column::Id.eq(user_id))
            .filter(users::Column::Disabled.eq(false))
            .exec(&tx)
            .await?;
        if updated.rows_affected != 1 {
            return Err(Error::Unauthorized);
        }
        let peers = revoke(&tx, user_id).await?;
        tx.commit().await?;
        Ok(peers)
    }
    pub async fn verify_email_change(
        &self,
        token: &str,
        user_id: &str,
    ) -> Result<(String, Vec<PeerAuthorization>)> {
        let tx = self.db.begin().await?;
        super::lock_authentication_generation(&tx).await?;
        let row = users::Entity::find_by_id(user_id)
            .filter(users::Column::Disabled.eq(false))
            .lock_exclusive()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        let challenge = challenges::Entity::delete_many()
            .filter(challenges::Column::TokenHash.eq(secret_hash(token)))
            .filter(challenges::Column::Purpose.eq("email"))
            .filter(challenges::Column::UserId.eq(user_id))
            .filter(challenges::Column::ExpiresAt.gt(now_ms()))
            .exec_with_returning(&tx)
            .await?
            .into_iter()
            .next()
            .ok_or(Error::Unauthorized)?;
        if challenge.record["version"].as_i64() != Some(row.credential_version) {
            return Err(Error::Unauthorized);
        }
        let previous = row.email;
        if users::Entity::find()
            .filter(users::Column::Email.eq(&challenge.email))
            .filter(users::Column::Id.ne(user_id))
            .one(&tx)
            .await?
            .is_some()
        {
            return Err(Error::Conflict("email address is unavailable"));
        }
        credential_mutation()
            .col_expr(users::Column::Email, Expr::val(challenge.email))
            .filter(users::Column::Id.eq(user_id))
            .exec(&tx)
            .await?;
        let peers = revoke(&tx, user_id).await?;
        tx.commit().await?;
        Ok((previous, peers))
    }
    pub async fn disable_account(
        &self,
        actor: &str,
        user_id: &str,
        disabled: bool,
    ) -> Result<Vec<PeerAuthorization>> {
        let tx = self.db.begin().await?;
        super::lock_authentication_generation(&tx).await?;
        admins::Entity::find_by_id(actor)
            .lock_shared()
            .select_only()
            .column(admins::Column::UserId)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::Forbidden)?;
        if actor == user_id && disabled {
            return Err(Error::Invalid(
                "cannot disable your own administrator account",
            ));
        }
        let previous = users::Entity::find_by_id(user_id)
            .lock_exclusive()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?
            .disabled;
        let changed = credential_mutation()
            .col_expr(users::Column::Disabled, Expr::val(disabled))
            .filter(users::Column::Id.eq(user_id))
            .exec(&tx)
            .await?;
        if changed.rows_affected != 1 {
            return Err(Error::NotFound);
        }
        let peers = revoke(&tx, user_id).await?;
        audit::Entity::insert(audit::ActiveModel {
            actor_user_id: Set(Some(actor.into())),
            source: Set("user".into()),
            action: Set("account.disable".into()),
            before_value: Set(json!({"userId":user_id,"disabled":previous})),
            after_value: Set(json!({"userId":user_id,"disabled":disabled})),
            occurred_at: Set(now_ms()),
            ..Default::default()
        })
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(peers)
    }
    pub async fn passkeys(&self, user_id: &str) -> Result<Vec<Value>> {
        Ok(passkeys::Entity::find().filter(passkeys::Column::UserId.eq(user_id)).order_by_asc(passkeys::Column::CreatedAt)
            .all(&self.db).await?.into_iter().map(|row| json!({"id":row.id,"name":row.name,"credentialId":row.credential_id,"record":row.record,"createdAt":row.created_at})).collect())
    }
    pub async fn save_passkey(
        &self,
        user_id: &str,
        credential_id: &str,
        record: Value,
        display_name: &str,
        session_id: &str,
    ) -> Result<()> {
        let tx = self.db.begin().await?;
        require_recent(&tx, user_id, session_id).await?;
        passkeys::Entity::insert(passkeys::ActiveModel {
            id: Set(uuid::Uuid::new_v4().to_string()),
            user_id: Set(user_id.into()),
            name: Set(name(display_name)?.into()),
            credential_id: Set(credential_id.into()),
            record: Set(record),
            created_at: Set(now_ms()),
        })
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn update_passkey_record(
        &self,
        user_id: &str,
        id: &str,
        record: Value,
        expected: Value,
    ) -> Result<()> {
        let changed = passkeys::Entity::update_many()
            .col_expr(passkeys::Column::Record, Expr::val(record))
            .filter(passkeys::Column::UserId.eq(user_id))
            .filter(passkeys::Column::Id.eq(id))
            .filter(passkeys::Column::Record.eq(expected))
            .exec(&self.db)
            .await?;
        if changed.rows_affected != 1 {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }
    pub async fn rename_passkey(&self, user_id: &str, id: &str, display_name: &str) -> Result<()> {
        let updated = passkeys::Entity::update_many()
            .col_expr(passkeys::Column::Name, Expr::val(name(display_name)?))
            .filter(passkeys::Column::UserId.eq(user_id))
            .filter(passkeys::Column::Id.eq(id))
            .exec(&self.db)
            .await?;
        if updated.rows_affected != 1 {
            return Err(Error::NotFound);
        }
        Ok(())
    }
    pub async fn remove_passkey(&self, user_id: &str, id: &str, session_id: &str) -> Result<()> {
        let tx = self.db.begin().await?;
        super::lock_authentication_generation(&tx).await?;
        require_recent(&tx, user_id, session_id).await?;
        users::Entity::find_by_id(user_id)
            .filter(users::Column::Disabled.eq(false))
            .lock_exclusive()
            .select_only()
            .column(users::Column::Id)
            .into_tuple::<String>()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        let removed = passkeys::Entity::delete_many()
            .filter(passkeys::Column::UserId.eq(user_id))
            .filter(passkeys::Column::Id.eq(id))
            .exec(&tx)
            .await?;
        if removed.rows_affected != 1 {
            return Err(Error::NotFound);
        }
        credential_mutation()
            .filter(users::Column::Id.eq(user_id))
            .exec(&tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}

pub(super) fn credential_mutation() -> sea_orm::UpdateMany<users::Entity> {
    users::Entity::update_many()
        .col_expr(
            users::Column::CredentialVersion,
            Expr::col(users::Column::CredentialVersion).add(1),
        )
        .col_expr(
            users::Column::AuthenticationGeneration,
            super::next_authentication_generation(),
        )
}

pub(super) async fn revoke(
    db: &impl ConnectionTrait,
    user_id: &str,
) -> Result<Vec<PeerAuthorization>> {
    sessions::Entity::update_many()
        .col_expr(sessions::Column::Revoked, Expr::val(true))
        .filter(sessions::Column::UserId.eq(user_id))
        .filter(sessions::Column::Revoked.eq(false))
        .exec(db)
        .await?;
    challenges::Entity::delete_many()
        .filter(challenges::Column::UserId.eq(user_id))
        .exec(db)
        .await?;
    peers::Entity::update_many()
        .col_expr(peers::Column::Revoked, Expr::val(true))
        .filter(peers::Column::UserId.eq(user_id))
        .filter(peers::Column::Revoked.eq(false))
        .exec_with_returning(db)
        .await?
        .into_iter()
        .map(|row| serde_json::from_value(row.grant_json).map_err(Error::from))
        .collect()
}

async fn require_recent(db: &impl ConnectionTrait, user_id: &str, session_id: &str) -> Result<()> {
    users::Entity::find_by_id(user_id)
        .filter(users::Column::Disabled.eq(false))
        .lock_exclusive()
        .select_only()
        .column(users::Column::Id)
        .into_tuple::<String>()
        .one(db)
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
        .one(db)
        .await?
        .ok_or(Error::Unauthorized)?;
    Ok(())
}
