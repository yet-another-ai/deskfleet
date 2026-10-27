use crate::{ControlStore, Error, Result, name, now_ms, one, secret, secret_hash, sql};
use sea_orm::{ConnectionTrait, TransactionTrait};
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
        let tx = self.db.begin().await?;
        tx.execute_raw(sql(
            "DELETE FROM cp_identity_challenges WHERE expires_at<$1",
            vec![now_ms().into()],
        ))
        .await?;
        tx.execute_raw(sql("INSERT INTO cp_identity_challenges(token_hash,purpose,user_id,email,record,expires_at) VALUES($1,$2,$3,$4,$5,$6)",vec![secret_hash(&token).into(),purpose.into(),user_id.map(str::to_owned).into(),email.into(),record.into(),(now_ms()+lifetime_ms).into()])).await?;
        tx.commit().await?;
        Ok(token)
    }
    pub async fn consume_identity_challenge(&self, token: &str, purpose: &str) -> Result<Value> {
        let row=one(&self.db,"DELETE FROM cp_identity_challenges WHERE token_hash=$1 AND purpose=$2 AND expires_at>$3 RETURNING user_id,email,record",vec![secret_hash(token).into(),purpose.into(),now_ms().into()]).await.map_err(|e|if matches!(e,Error::NotFound){Error::Unauthorized}else{e})?;
        Ok(
            json!({"userId":row.try_get::<Option<String>>("","user_id")?,"email":row.try_get::<String>("","email")?,"record":row.try_get::<Value>("","record")?}),
        )
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
        let challenge=one(&tx,"DELETE FROM cp_identity_challenges WHERE token_hash=$1 AND purpose='registration' AND expires_at>$2 RETURNING email",vec![secret_hash(token).into(),now_ms().into()]).await.map_err(|e|if matches!(e,Error::NotFound){Error::Unauthorized}else{e})?;
        let email: String = challenge.try_get("", "email")?;
        let row=tx.query_one_raw(sql("INSERT INTO cp_users(id,name,email,email_verified,password_hash) VALUES($1,$2,$3,TRUE,$4) ON CONFLICT(email) DO NOTHING RETURNING id,name,email",vec![uuid::Uuid::now_v7().to_string().into(),name(display_name)?.into(),email.clone().into(),password_hash.into()])).await?.ok_or(Error::Conflict("account already exists; sign in or recover your password"))?;
        tx.execute_raw(sql(
            "DELETE FROM cp_identity_challenges WHERE email=$1 AND purpose='registration'",
            vec![email.into()],
        ))
        .await?;
        let user = super::user(&row)?;
        tx.commit().await?;
        Ok(user)
    }
}
