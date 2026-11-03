use crate::policies::{MachineAction, MachinePolicy, authorize};
use crate::{ControlStore, Error, Result, json_rows, now_ms, one, resource_id, sql};
use deskfleet_protocol::control::PeerAuthorization;
use sea_orm::{ConnectionTrait, TransactionTrait};

// The daemon RPC may take 60 seconds. Leave another minute for routing and
// final authorization/activation, without retaining abandoned grants all day.
const PROVISIONING_LEASE_MS: i64 = 120_000;

impl ControlStore {
    /// Reserve capacity while external provisioning is in flight. Cancellation
    /// and process loss leave at most two minutes of quota occupancy, without
    /// relying on an async cleanup task running after the request is dropped.
    pub async fn reserve_peer(
        &self,
        auth: &PeerAuthorization,
        login_id: &str,
        expires: i64,
    ) -> Result<()> {
        self.insert_peer(auth, login_id, expires, true).await
    }

    /// Activate only a still-live reservation, using its immutable grant expiry.
    /// Call after provisioning and final authorization, immediately before reply.
    pub async fn activate_peer(&self, id: &str) -> Result<()> {
        let tx = self.db.begin().await?;
        let row = one(
            &tx,
            "SELECT grant_json FROM cp_peers WHERE id=$1",
            vec![id.into()],
        )
        .await?;
        let grant: PeerAuthorization = serde_json::from_value(row.try_get("", "grant_json")?)?;
        // Serialize lease activation with new admission so a lease expiring
        // during this transaction cannot be counted free and then resurrected.
        crate::peer_admission::lock(&tx, &grant.actor.user_id, resource_id(&grant.team_id)?)
            .await?;
        let expires = chrono::DateTime::parse_from_rfc3339(&grant.expires_at)
            .map_err(|_| Error::Invalid("invalid peer expiry"))?
            .timestamp_millis();
        let updated = tx
            .execute_raw(sql(
                "UPDATE cp_peers SET expires_at=$2 WHERE id=$1 AND NOT revoked AND expires_at>$3",
                vec![id.into(), expires.into(), now_ms().into()],
            ))
            .await?;
        if updated.rows_affected() == 0 {
            return Err(Error::NotFound);
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn save_peer(
        &self,
        auth: &PeerAuthorization,
        login_id: &str,
        expires: i64,
    ) -> Result<()> {
        self.insert_peer(auth, login_id, expires, false).await
    }

    async fn insert_peer(
        &self,
        auth: &PeerAuthorization,
        login_id: &str,
        expires: i64,
        provisioning: bool,
    ) -> Result<()> {
        let machine_id = resource_id(&auth.target_machine.id)?;
        let team_id = resource_id(&auth.team_id)?;
        // These committed windows also charge failed create/close attempts.
        // Consume them before opening the grant transaction, never holding a
        // pooled connection while waiting for another one.
        if !self
            .auth_rate_limit(
                &format!("peer-issue-user:{}", auth.actor.user_id),
                60,
                60_000,
            )
            .await?
            || !self
                .auth_rate_limit(
                    &format!("peer-issue-registration:{team_id}:{machine_id}"),
                    240,
                    60_000,
                )
                .await?
        {
            return Err(Error::Limited("peer issuance rate exceeded"));
        }
        let tx = self.db.begin().await?;
        // Lock FK parents before membership/login rows: revocation locks those
        // parents first, and INSERT otherwise acquires their FK locks last.
        one(
            &tx,
            "SELECT id FROM cp_users WHERE id=$1 AND NOT disabled AND email_verified FOR SHARE",
            vec![auth.actor.user_id.clone().into()],
        )
        .await?;
        one(
            &tx,
            "SELECT id FROM cp_teams WHERE id=$1 FOR SHARE",
            vec![team_id.into()],
        )
        .await?;
        let membership = one(&tx, "SELECT member.role,m.id AS registration_id FROM cp_machine_registrations m JOIN cp_members member ON member.team_id=m.team_id JOIN cp_login_sessions login ON login.user_id=member.user_id WHERE m.machine_id=$1 AND m.team_id=$2 AND member.user_id=$3 AND login.id=$4 AND NOT m.revoked AND NOT login.revoked AND login.expires_at>$5 AND m.origin_id=$6 AND m.local_machine_id=$7 FOR SHARE OF m,member,login", vec![machine_id.into(),team_id.into(),auth.actor.user_id.clone().into(),login_id.into(),now_ms().into(),auth.target_machine.origin_id.clone().into(),auth.target_machine.local_machine_id.clone().into()]).await?;
        let registration_id: i64 = membership.try_get("", "registration_id")?;
        let role = membership.try_get::<String>("", "role")?.parse()?;
        authorize(&MachinePolicy::new(Some(role)), MachineAction::Connect)?;
        crate::peer_admission::reserve(&tx, auth, login_id, team_id, registration_id).await?;
        // Start the lease after waiting for admission, rather than consuming it
        // while authentication or another grant transaction holds the locks.
        let expires = if provisioning {
            expires.min(now_ms() + PROVISIONING_LEASE_MS)
        } else {
            expires
        };
        tx.execute_raw(sql("INSERT INTO cp_peers(id,registration_id,team_id,user_id,login_session_id,grant_json,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",vec![auth.peer_id.clone().into(),registration_id.into(),team_id.into(),auth.actor.user_id.clone().into(),login_id.into(),serde_json::to_value(auth)?.into(),expires.into()])).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn peer(&self, id: &str, login_id: &str) -> Result<PeerAuthorization> {
        let row=one(&self.db,"SELECT grant_json FROM cp_peers WHERE id=$1 AND login_session_id=$2 AND NOT revoked AND expires_at>$3",vec![id.into(),login_id.into(),now_ms().into()]).await?;
        Ok(serde_json::from_value(row.try_get("", "grant_json")?)?)
    }
    /// Look up a login's peer for cleanup, including revoked or expired grants.
    ///
    /// This does not authorize further peer operations. Callers must still
    /// authenticate the login and check its current access to the target machine.
    pub async fn peer_for_close(&self, id: &str, login_id: &str) -> Result<PeerAuthorization> {
        let row = one(
            &self.db,
            "SELECT grant_json FROM cp_peers WHERE id=$1 AND login_session_id=$2",
            vec![id.into(), login_id.into()],
        )
        .await?;
        Ok(serde_json::from_value(row.try_get("", "grant_json")?)?)
    }
    pub async fn valid_machine_peers(&self, machine_id: &str) -> Result<Vec<PeerAuthorization>> {
        json_rows(&self.db,"SELECT p.grant_json AS record FROM cp_peers p JOIN cp_members m ON m.team_id=p.team_id AND m.user_id=p.user_id JOIN cp_login_sessions s ON s.id=p.login_session_id WHERE p.registration_id=$1 AND NOT p.revoked AND p.expires_at>$2 AND NOT s.revoked",vec![resource_id(machine_id)?.into(),now_ms().into()]).await?.into_iter().map(|v|serde_json::from_value(v).map_err(crate::Error::from)).collect()
    }
    pub async fn peer_login(&self, id: &str, machine_id: &str) -> Result<String> {
        let row=one(&self.db,"SELECT login_session_id FROM cp_peers WHERE id=$1 AND registration_id=$2 AND NOT revoked AND expires_at>$3",vec![id.into(),resource_id(machine_id)?.into(),now_ms().into()]).await?;
        Ok(row.try_get("", "login_session_id")?)
    }
    pub async fn revoke_peer(&self, id: &str) -> Result<Vec<PeerAuthorization>> {
        self.revoke("id=$1", vec![id.into()]).await
    }
    pub async fn revoke_login_peers(&self, id: &str) -> Result<Vec<PeerAuthorization>> {
        self.revoke("login_session_id=$1", vec![id.into()]).await
    }
    pub async fn revoke_machine_peers(&self, id: &str) -> Result<Vec<PeerAuthorization>> {
        self.revoke("registration_id=$1", vec![resource_id(id)?.into()])
            .await
    }
    pub async fn revoke_member_peers(
        &self,
        team_id: &str,
        user_id: &str,
    ) -> Result<Vec<PeerAuthorization>> {
        self.revoke(
            "team_id=$1 AND user_id=$2",
            vec![resource_id(team_id)?.into(), user_id.into()],
        )
        .await
    }
    async fn revoke(
        &self,
        predicate: &str,
        values: Vec<sea_orm::Value>,
    ) -> Result<Vec<PeerAuthorization>> {
        json_rows(&self.db,&format!("UPDATE cp_peers SET revoked=TRUE WHERE NOT revoked AND {predicate} RETURNING grant_json AS record"),values).await?.into_iter().map(|v|serde_json::from_value(v).map_err(crate::Error::from)).collect()
    }
}
