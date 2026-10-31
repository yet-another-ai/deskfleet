//! Short-lived mailbox proofs bound to one existing login session.
use crate::{ControlStore, Error, Result, now_ms, one, secret, secret_hash, sql};
use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::{Value, json};

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
        let user = one(&tx, "SELECT email,credential_version FROM cp_users WHERE id=$1 AND email_verified AND NOT disabled FOR UPDATE", vec![user_id.into()]).await?;
        one(&tx, "SELECT id FROM cp_login_sessions WHERE id=$1 AND user_id=$2 AND NOT revoked AND expires_at>$3 FOR SHARE", vec![session_id.into(), user_id.into(), now_ms().into()]).await?;
        let email: String = user.try_get("", "email")?;
        let version: i64 = user.try_get("", "credential_version")?;
        let challenge = secret();
        let code = code();
        let record = json!({"sessionId":session_id,"version":version,"codeHash":secret_hash(&format!("{challenge}:{code}")),"attempts":0});
        tx.execute_raw(sql("DELETE FROM cp_identity_challenges WHERE user_id=$1 AND purpose='email_reauthentication' AND record->>'sessionId'=$2", vec![user_id.into(), session_id.into()])).await?;
        tx.execute_raw(sql("INSERT INTO cp_identity_challenges(token_hash,purpose,user_id,email,record,expires_at) VALUES($1,'email_reauthentication',$2,$3,$4,$5)", vec![secret_hash(&challenge).into(), user_id.into(), email.clone().into(), record.into(), (now_ms()+600_000).into()])).await?;
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
        one(
            &tx,
            "SELECT id FROM cp_users WHERE id=$1 AND email_verified AND NOT disabled FOR UPDATE",
            vec![user_id.into()],
        )
        .await?;
        let token_hash = secret_hash(challenge);
        let row = tx.query_one_raw(sql("SELECT record,email FROM cp_identity_challenges WHERE token_hash=$1 AND purpose='email_reauthentication' AND user_id=$2 AND record->>'sessionId'=$3 AND expires_at>$4 FOR UPDATE", vec![token_hash.clone().into(), user_id.into(), session_id.into(), now_ms().into()])).await?.ok_or(Error::Unauthorized)?;
        let mut record: Value = row.try_get("", "record")?;
        let attempts = record["attempts"].as_u64().ok_or(Error::Unauthorized)?;
        if attempts >= 5 {
            return Err(Error::Unauthorized);
        }
        if record["codeHash"] != secret_hash(&format!("{challenge}:{code}")) {
            record["attempts"] = json!(attempts + 1);
            tx.execute_raw(sql(
                "UPDATE cp_identity_challenges SET record=$1 WHERE token_hash=$2",
                vec![record.into(), token_hash.into()],
            ))
            .await?;
            tx.commit().await?;
            return Err(Error::Unauthorized);
        }
        let version = record["version"].as_i64().ok_or(Error::Unauthorized)?;
        let email: String = row.try_get("", "email")?;
        let updated = tx.execute_raw(sql("UPDATE cp_login_sessions s SET authenticated_at=$1 FROM cp_users u WHERE s.id=$2 AND s.user_id=$3 AND u.id=s.user_id AND u.credential_version=$4 AND u.email=$5 AND u.email_verified AND NOT u.disabled AND NOT s.revoked AND s.expires_at>$1", vec![now_ms().into(), session_id.into(), user_id.into(), version.into(), email.into()])).await?;
        if updated.rows_affected() != 1 {
            return Err(Error::Unauthorized);
        }
        tx.execute_raw(sql(
            "DELETE FROM cp_identity_challenges WHERE token_hash=$1",
            vec![token_hash.into()],
        ))
        .await?;
        tx.commit().await?;
        Ok(())
    }
}
