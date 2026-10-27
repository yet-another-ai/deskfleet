use crate::{ControlStore, Error, Result, json_rows, name, now_ms, one, secret_hash, sql};
use deskfleet_protocol::control::PeerAuthorization;
use sea_orm::{ConnectionTrait, TransactionTrait};
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
        let challenge=one(&tx,"DELETE FROM cp_identity_challenges WHERE token_hash=$1 AND purpose='recovery' AND expires_at>$2 RETURNING user_id,record",vec![secret_hash(token).into(),now_ms().into()]).await.map_err(|e|if matches!(e,Error::NotFound){Error::Unauthorized}else{e})?;
        let user_id: String = challenge.try_get("", "user_id")?;
        let record: Value = challenge.try_get("", "record")?;
        let version = record["version"].as_i64().ok_or(Error::Unauthorized)?;
        let updated=tx.execute_raw(sql("UPDATE cp_users SET password_hash=$1,credential_version=credential_version+1 WHERE id=$2 AND NOT disabled AND credential_version=$3",vec![password_hash.into(),user_id.clone().into(),version.into()])).await?;
        if updated.rows_affected() != 1 {
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
        require_recent(&tx, user_id, session_id).await?;
        let updated=tx.execute_raw(sql("UPDATE cp_users SET password_hash=$1,credential_version=credential_version+1 WHERE id=$2 AND NOT disabled",vec![password_hash.into(),user_id.into()])).await?;
        if updated.rows_affected() != 1 {
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
        let challenge=one(&tx,"DELETE FROM cp_identity_challenges WHERE token_hash=$1 AND purpose='email' AND user_id=$2 AND expires_at>$3 RETURNING email,record",vec![secret_hash(token).into(),user_id.into(),now_ms().into()]).await.map_err(|e|if matches!(e,Error::NotFound){Error::Unauthorized}else{e})?;
        let email: String = challenge.try_get("", "email")?;
        let record: Value = challenge.try_get("", "record")?;
        let row = one(
            &tx,
            "SELECT email,credential_version FROM cp_users WHERE id=$1 AND NOT disabled FOR UPDATE",
            vec![user_id.into()],
        )
        .await?;
        if record["version"].as_i64() != Some(row.try_get("", "credential_version")?) {
            return Err(Error::Unauthorized);
        }
        let previous: String = row.try_get("", "email")?;
        if tx
            .query_one_raw(sql(
                "SELECT id FROM cp_users WHERE email=$1 AND id<>$2",
                vec![email.clone().into(), user_id.into()],
            ))
            .await?
            .is_some()
        {
            return Err(Error::Conflict("email address is unavailable"));
        }
        tx.execute_raw(sql(
            "UPDATE cp_users SET email=$1,credential_version=credential_version+1 WHERE id=$2",
            vec![email.into(), user_id.into()],
        ))
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
        if actor == user_id && disabled {
            return Err(Error::Invalid(
                "cannot disable your own administrator account",
            ));
        }
        let previous: bool = one(
            &tx,
            "SELECT disabled FROM cp_users WHERE id=$1 FOR UPDATE",
            vec![user_id.into()],
        )
        .await?
        .try_get("", "disabled")?;
        let changed=tx.execute_raw(sql("UPDATE cp_users SET disabled=$1,credential_version=credential_version+1 WHERE id=$2",vec![disabled.into(),user_id.into()])).await?;
        if changed.rows_affected() != 1 {
            return Err(Error::NotFound);
        }
        let peers = revoke(&tx, user_id).await?;
        tx.execute_raw(sql("INSERT INTO cp_site_audit(actor_user_id,source,action,before_value,after_value,occurred_at) VALUES($1,'user','account.disable',$2,$3,$4)",vec![actor.into(),json!({"userId":user_id,"disabled":previous}).into(),json!({"userId":user_id,"disabled":disabled}).into(),now_ms().into()])).await?;
        tx.commit().await?;
        Ok(peers)
    }
    pub async fn passkeys(&self, user_id: &str) -> Result<Vec<Value>> {
        json_rows(&self.db,"SELECT jsonb_build_object('id',id,'name',name,'credentialId',credential_id,'record',record,'createdAt',created_at) AS record FROM cp_passkeys WHERE user_id=$1 ORDER BY created_at",vec![user_id.into()]).await
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
        tx.execute_raw(sql("INSERT INTO cp_passkeys(id,user_id,name,credential_id,record,created_at) VALUES($1,$2,$3,$4,$5,$6)",vec![uuid::Uuid::new_v4().to_string().into(),user_id.into(),name(display_name)?.into(),credential_id.into(),record.into(),now_ms().into()])).await?;
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
        let changed = self
            .db
            .execute_raw(sql(
                "UPDATE cp_passkeys SET record=$1 WHERE user_id=$2 AND id=$3 AND record=$4",
                vec![record.into(), user_id.into(), id.into(), expected.into()],
            ))
            .await?;
        if changed.rows_affected() != 1 {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }
    pub async fn rename_passkey(&self, user_id: &str, id: &str, display_name: &str) -> Result<()> {
        let updated = self
            .db
            .execute_raw(sql(
                "UPDATE cp_passkeys SET name=$1 WHERE user_id=$2 AND id=$3",
                vec![name(display_name)?.into(), user_id.into(), id.into()],
            ))
            .await?;
        if updated.rows_affected() != 1 {
            return Err(Error::NotFound);
        }
        Ok(())
    }
    pub async fn remove_passkey(&self, user_id: &str, id: &str, session_id: &str) -> Result<()> {
        let tx = self.db.begin().await?;
        require_recent(&tx, user_id, session_id).await?;
        one(
            &tx,
            "SELECT id FROM cp_users WHERE id=$1 AND NOT disabled FOR UPDATE",
            vec![user_id.into()],
        )
        .await?;
        let removed = tx
            .execute_raw(sql(
                "DELETE FROM cp_passkeys WHERE user_id=$1 AND id=$2",
                vec![user_id.into(), id.into()],
            ))
            .await?;
        if removed.rows_affected() != 1 {
            return Err(Error::NotFound);
        }
        tx.execute_raw(sql(
            "UPDATE cp_users SET credential_version=credential_version+1 WHERE id=$1",
            vec![user_id.into()],
        ))
        .await?;
        tx.commit().await?;
        Ok(())
    }
}
async fn revoke(db: &impl ConnectionTrait, user_id: &str) -> Result<Vec<PeerAuthorization>> {
    db.execute_raw(sql(
        "UPDATE cp_login_sessions SET revoked=TRUE WHERE user_id=$1",
        vec![user_id.into()],
    ))
    .await?;
    db.execute_raw(sql(
        "DELETE FROM cp_identity_challenges WHERE user_id=$1",
        vec![user_id.into()],
    ))
    .await?;
    json_rows(db,"UPDATE cp_peers SET revoked=TRUE WHERE user_id=$1 AND NOT revoked RETURNING grant_json AS record",vec![user_id.into()]).await?.into_iter().map(|v|serde_json::from_value(v).map_err(Error::from)).collect()
}

async fn require_recent(db: &impl ConnectionTrait, user_id: &str, session_id: &str) -> Result<()> {
    one(
        db,
        "SELECT id FROM cp_users WHERE id=$1 AND NOT disabled FOR UPDATE",
        vec![user_id.into()],
    )
    .await?;
    one(db,"SELECT id FROM cp_login_sessions WHERE id=$1 AND user_id=$2 AND NOT revoked AND expires_at>$3 AND authenticated_at>$4 FOR SHARE",vec![session_id.into(),user_id.into(),now_ms().into(),(now_ms()-600_000).into()]).await.map_err(|e|if matches!(e,Error::NotFound){Error::Unauthorized}else{e})?;
    Ok(())
}
