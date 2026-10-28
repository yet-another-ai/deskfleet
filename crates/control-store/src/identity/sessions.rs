use crate::{
    AuthSession, ControlStore, Error, Result, now_ms, one, secret, secret_hash, sql, timestamp,
};
use deskfleet_protocol::control::{PeerAuthorization, User};
use sea_orm::{ConnectionTrait, TransactionTrait};
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
        let tx = self.db.begin().await?;
        let row = one(&tx,"SELECT id,name,email,credential_version FROM cp_users WHERE id=$1 AND NOT disabled AND email_verified FOR SHARE",vec![user_id.into()]).await.map_err(|e| if matches!(e, Error::NotFound){Error::Unauthorized}else{e})?;
        if version.is_some_and(|v| row.try_get::<i64>("", "credential_version").ok() != Some(v)) {
            return Err(Error::Unauthorized);
        }
        let token = secret();
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let expires = now + 30 * 24 * 60 * 60 * 1000;
        tx.execute_raw(sql("INSERT INTO cp_login_sessions(id,user_id,device_id,token_hash,created_at,authenticated_at,expires_at) VALUES($1,$2,$1,$3,$4,$4,$5)",vec![id.clone().into(),user_id.into(),secret_hash(&token).into(),now.into(),expires.into()])).await?;
        let user = super::user(&row)?;
        tx.commit().await?;
        Ok(json!({"token":token,"user":user,"sessionId":id,"expiresAt":timestamp(expires)}))
    }
    pub async fn authenticate(&self, token: &str) -> Result<AuthSession> {
        let row=self.db.query_one_raw(sql("SELECT s.id,s.device_id,u.id AS user_id,u.name,u.email FROM cp_login_sessions s JOIN cp_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND NOT s.revoked AND s.expires_at>$2 AND NOT u.disabled AND u.email_verified",vec![secret_hash(token).into(),now_ms().into()])).await?.ok_or(Error::Unauthorized)?;
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
        Ok(self.db.query_one_raw(sql("SELECT s.id FROM cp_login_sessions s JOIN cp_users u ON u.id=s.user_id WHERE s.id=$1 AND NOT s.revoked AND s.expires_at>$2 AND NOT u.disabled AND u.email_verified",vec![id.into(),now_ms().into()])).await?.is_some())
    }
    pub async fn recent_authentication(&self, id: &str) -> Result<bool> {
        Ok(self.db.query_one_raw(sql("SELECT id FROM cp_login_sessions WHERE id=$1 AND NOT revoked AND expires_at>$2 AND authenticated_at>$3",vec![id.into(),now_ms().into(),(now_ms()-600_000).into()])).await?.is_some())
    }
    pub async fn refresh_authentication(&self, id: &str, version: i64) -> Result<()> {
        let result = self.db.execute_raw(sql("UPDATE cp_login_sessions s SET authenticated_at=$1 FROM cp_users u WHERE s.id=$2 AND u.id=s.user_id AND NOT u.disabled AND u.credential_version=$3 AND NOT s.revoked AND s.expires_at>$1",vec![now_ms().into(),id.into(),version.into()])).await?;
        if result.rows_affected() != 1 {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }
    pub async fn login_sessions(&self, user_id: &str, current: &str) -> Result<Vec<Value>> {
        self.db.query_all_raw(sql("SELECT id,device_id,created_at,expires_at FROM cp_login_sessions WHERE user_id=$1 AND NOT revoked AND expires_at>$2 ORDER BY created_at DESC",vec![user_id.into(),now_ms().into()])).await?.into_iter().map(|row|{let id:String=row.try_get("","id")?;Ok(json!({"current":id==current,"id":id,"deviceId":row.try_get::<String>("","device_id")?,"createdAt":timestamp(row.try_get("","created_at")?),"expiresAt":timestamp(row.try_get("","expires_at")?)}))}).collect()
    }
    pub async fn logout(&self, id: &str) -> Result<()> {
        self.db
            .execute_raw(sql(
                "UPDATE cp_login_sessions SET revoked=TRUE WHERE id=$1",
                vec![id.into()],
            ))
            .await?;
        Ok(())
    }
    pub async fn revoke_user_sessions(
        &self,
        user_id: &str,
        session_id: Option<&str>,
    ) -> Result<Vec<PeerAuthorization>> {
        let tx = self.db.begin().await?;
        one(
            &tx,
            "SELECT id FROM cp_users WHERE id=$1 FOR UPDATE",
            vec![user_id.into()],
        )
        .await?;
        tx.execute_raw(sql("UPDATE cp_login_sessions SET revoked=TRUE WHERE user_id=$1 AND NOT revoked AND ($2::text IS NULL OR id=$2)",vec![user_id.into(),session_id.map(str::to_owned).into()])).await?;
        if session_id.is_none() {
            // Outstanding native codes and login ceremonies must not recreate a
            // session after the owner has explicitly revoked every session.
            tx.execute_raw(sql(
                "UPDATE cp_users SET credential_version=credential_version+1 WHERE id=$1",
                vec![user_id.into()],
            ))
            .await?;
            tx.execute_raw(sql(
                "DELETE FROM cp_login_codes WHERE user_id=$1",
                vec![user_id.into()],
            ))
            .await?;
            tx.execute_raw(sql(
                "DELETE FROM cp_identity_challenges WHERE user_id=$1",
                vec![user_id.into()],
            ))
            .await?;
        }
        let peers=crate::json_rows(&tx,"UPDATE cp_peers SET revoked=TRUE WHERE user_id=$1 AND ($2::text IS NULL OR login_session_id=$2) AND NOT revoked RETURNING grant_json AS record",vec![user_id.into(),session_id.map(str::to_owned).into()]).await?.into_iter().map(serde_json::from_value).collect::<std::result::Result<Vec<_>,_>>()?;
        tx.commit().await?;
        Ok(peers)
    }
    pub async fn save_login_attempt(&self, state: &str, record: Value) -> Result<()> {
        self.db
            .execute_raw(sql(
                "INSERT INTO cp_login_attempts VALUES($1,$2,$3)",
                vec![
                    secret_hash(state).into(),
                    record.into(),
                    (now_ms() + 600_000).into(),
                ],
            ))
            .await?;
        Ok(())
    }
    pub async fn consume_login_attempt(&self, state: &str) -> Result<Value> {
        Ok(one(
            &self.db,
            "DELETE FROM cp_login_attempts WHERE state_hash=$1 AND expires_at>$2 RETURNING record",
            vec![secret_hash(state).into(), now_ms().into()],
        )
        .await
        .map_err(|e| {
            if matches!(e, Error::NotFound) {
                Error::Unauthorized
            } else {
                e
            }
        })?
        .try_get("", "record")?)
    }
    pub async fn new_login_code(&self, user_id: &str, verifier_hash: &str) -> Result<String> {
        let code = secret();
        let result=self.db.execute_raw(sql("INSERT INTO cp_login_codes(code_hash,user_id,verifier_hash,credential_version,expires_at) SELECT $1,id,$3,credential_version,$4 FROM cp_users WHERE id=$2 AND NOT disabled AND email_verified",vec![secret_hash(&code).into(),user_id.into(),verifier_hash.into(),(now_ms()+60_000).into()])).await?;
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
        let row=one(&tx,"SELECT credential_version FROM cp_users WHERE id=$1 AND NOT disabled AND email_verified FOR UPDATE",vec![user_id.into()]).await?;
        one(&tx,"SELECT id FROM cp_login_sessions WHERE id=$1 AND user_id=$2 AND NOT revoked AND expires_at>$3 AND authenticated_at>$4 FOR SHARE",vec![session_id.into(),user_id.into(),now_ms().into(),(now_ms()-600_000).into()]).await.map_err(|e|if matches!(e,Error::NotFound){Error::Unauthorized}else{e})?;
        let code = secret();
        tx.execute_raw(sql("INSERT INTO cp_login_codes(code_hash,user_id,verifier_hash,credential_version,expires_at) VALUES($1,$2,$3,$4,$5)",vec![secret_hash(&code).into(),user_id.into(),verifier_hash.into(),row.try_get::<i64>("","credential_version")?.into(),(now_ms()+60_000).into()])).await?;
        tx.commit().await?;
        Ok(code)
    }
    pub async fn exchange_login_code(&self, code: &str, verifier: &str) -> Result<Value> {
        let row=one(&self.db,"DELETE FROM cp_login_codes WHERE code_hash=$1 AND expires_at>$2 AND verifier_hash=$3 RETURNING user_id,credential_version",vec![secret_hash(code).into(),now_ms().into(),secret_hash(verifier).into()]).await.map_err(|e|if matches!(e,Error::NotFound){Error::Unauthorized}else{e})?;
        self.new_session_at_version(
            &row.try_get::<String>("", "user_id")?,
            Some(row.try_get("", "credential_version")?),
        )
        .await
    }
}
