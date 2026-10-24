use crate::{
    AuthSession, ControlStore, Error, Result, now_ms, one, secret, secret_hash, sql, timestamp,
};
use deskfleet_protocol::control::User;
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};

impl ControlStore {
    pub async fn oidc_user(
        &self,
        issuer: &str,
        subject: &str,
        name: &str,
        email: Option<&str>,
        verified: bool,
    ) -> Result<User> {
        let row = one(&self.db, "INSERT INTO cp_users(id,issuer,subject,name,email,email_verified) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(issuer,subject) DO UPDATE SET name=excluded.name,email=excluded.email,email_verified=excluded.email_verified RETURNING id,name,email", vec![uuid::Uuid::now_v7().to_string().into(),issuer.into(),subject.into(),name.into(),email.map(str::to_owned).into(),verified.into()]).await?;
        Ok(User {
            id: row.try_get("", "id")?,
            name: row.try_get("", "name")?,
            email: row.try_get("", "email")?,
        })
    }
    pub async fn new_session(&self, user_id: &str) -> Result<Value> {
        let token = secret();
        let id = uuid::Uuid::new_v4().to_string();
        let expires = now_ms() + 30 * 24 * 60 * 60 * 1000;
        self.db.execute_raw(sql("INSERT INTO cp_login_sessions(id,user_id,device_id,token_hash,expires_at) VALUES($1,$2,$1,$3,$4)",vec![id.into(),user_id.into(),secret_hash(&token).into(),expires.into()])).await?;
        let auth = self.authenticate(&token).await?;
        Ok(json!({"token":token,"user":auth.user,"expiresAt":timestamp(expires)}))
    }
    pub async fn authenticate(&self, token: &str) -> Result<AuthSession> {
        let row=self.db.query_one_raw(sql("SELECT s.id,s.device_id,u.id AS user_id,u.name,u.email FROM cp_login_sessions s JOIN cp_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND NOT s.revoked AND s.expires_at>$2",vec![secret_hash(token).into(),now_ms().into()])).await?.ok_or(Error::Unauthorized)?;
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
            .query_one_raw(sql(
                "SELECT id FROM cp_login_sessions WHERE id=$1 AND NOT revoked AND expires_at>$2",
                vec![id.into(), now_ms().into()],
            ))
            .await?
            .is_some())
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
    pub async fn save_login_attempt(&self, state: &str, record: Value) -> Result<()> {
        self.db
            .execute_raw(sql(
                "DELETE FROM cp_login_attempts WHERE expires_at<$1",
                vec![now_ms().into()],
            ))
            .await?;
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
        let row = one(
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
        })?;
        Ok(row.try_get("", "record")?)
    }
    pub async fn new_login_code(&self, user_id: &str, verifier_hash: &str) -> Result<String> {
        let code = secret();
        self.db
            .execute_raw(sql(
                "INSERT INTO cp_login_codes VALUES($1,$2,$3,$4)",
                vec![
                    secret_hash(&code).into(),
                    user_id.into(),
                    verifier_hash.into(),
                    (now_ms() + 60_000).into(),
                ],
            ))
            .await?;
        Ok(code)
    }
    pub async fn exchange_login_code(&self, code: &str, verifier: &str) -> Result<Value> {
        let row=one(&self.db,"DELETE FROM cp_login_codes WHERE code_hash=$1 AND expires_at>$2 AND verifier_hash=$3 RETURNING user_id",vec![secret_hash(code).into(),now_ms().into(),secret_hash(verifier).into()]).await.map_err(|e|if matches!(e,Error::NotFound){Error::Unauthorized}else{e})?;
        self.new_session(&row.try_get::<String>("", "user_id")?)
            .await
    }
}
