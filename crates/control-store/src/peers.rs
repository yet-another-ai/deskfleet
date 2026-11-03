use crate::entities::{
    cp_login_sessions as logins, cp_machine_registrations as registrations, cp_members as members,
    cp_peers as peers, cp_teams as teams, cp_users as users,
};
use crate::policies::{MachineAction, MachinePolicy, authorize};
use crate::{ControlStore, Error, Result, json_query, now_ms, one_query, resource_id};
use deskfleet_protocol::control::PeerAuthorization;
use sea_orm::sea_query::{Alias, Expr, ExprTrait, JoinType, LockType, Query};
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
        let row = one_query(
            &tx,
            Query::select()
                .column(peers::Column::GrantJson)
                .from(peers::Entity)
                .and_where(Expr::col(peers::Column::Id).eq(id)),
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
            .execute(
                Query::update()
                    .table(peers::Entity)
                    .value(peers::Column::ExpiresAt, expires)
                    .and_where(Expr::col(peers::Column::Id).eq(id))
                    .and_where(Expr::col(peers::Column::Revoked).not())
                    .and_where(Expr::col(peers::Column::ExpiresAt).gt(now_ms())),
            )
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
        one_query(
            &tx,
            Query::select()
                .column(users::Column::Id)
                .from(users::Entity)
                .and_where(Expr::col(users::Column::Id).eq(&auth.actor.user_id))
                .and_where(Expr::col(users::Column::Disabled).not())
                .and_where(Expr::col(users::Column::EmailVerified))
                .lock(LockType::Share),
        )
        .await?;
        one_query(
            &tx,
            Query::select()
                .column(teams::Column::Id)
                .from(teams::Entity)
                .and_where(Expr::col(teams::Column::Id).eq(team_id))
                .lock(LockType::Share),
        )
        .await?;
        let membership = one_query(
            &tx,
            Query::select()
                .column((members::Entity, members::Column::Role))
                .expr_as(
                    Expr::col((registrations::Entity, registrations::Column::Id)),
                    peers::Column::RegistrationId,
                )
                .from(registrations::Entity)
                .join(
                    JoinType::InnerJoin,
                    members::Entity,
                    Expr::col((members::Entity, members::Column::TeamId))
                        .equals((registrations::Entity, registrations::Column::TeamId)),
                )
                .join(
                    JoinType::InnerJoin,
                    logins::Entity,
                    Expr::col((logins::Entity, logins::Column::UserId))
                        .equals((members::Entity, members::Column::UserId)),
                )
                .and_where(
                    Expr::col((registrations::Entity, registrations::Column::MachineId))
                        .eq(machine_id),
                )
                .and_where(
                    Expr::col((registrations::Entity, registrations::Column::TeamId)).eq(team_id),
                )
                .and_where(
                    Expr::col((members::Entity, members::Column::UserId)).eq(&auth.actor.user_id),
                )
                .and_where(Expr::col((logins::Entity, logins::Column::Id)).eq(login_id))
                .and_where(Expr::col((registrations::Entity, registrations::Column::Revoked)).not())
                .and_where(Expr::col((logins::Entity, logins::Column::Revoked)).not())
                .and_where(Expr::col((logins::Entity, logins::Column::ExpiresAt)).gt(now_ms()))
                .and_where(
                    Expr::col((registrations::Entity, registrations::Column::OriginId))
                        .eq(&auth.target_machine.origin_id),
                )
                .and_where(
                    Expr::col((registrations::Entity, registrations::Column::LocalMachineId))
                        .eq(&auth.target_machine.local_machine_id),
                )
                .lock_with_tables(
                    LockType::Share,
                    [
                        sea_orm::sea_query::IntoTableRef::into_table_ref(registrations::Entity),
                        sea_orm::sea_query::IntoTableRef::into_table_ref(members::Entity),
                        sea_orm::sea_query::IntoTableRef::into_table_ref(logins::Entity),
                    ],
                ),
        )
        .await?;
        let registration_id: i64 = membership.try_get("", "registration_id")?;
        let role = membership.try_get::<String>("", "role")?.parse()?;
        authorize(&MachinePolicy::new(Some(role)), MachineAction::Connect)?;
        crate::peer_admission::reserve(&tx, auth, login_id, team_id, registration_id).await?;
        // Start the lease after waiting for admission, rather than consuming it
        // while authentication or another grant transaction holds the locks.
        let expires = if provisioning {
            std::cmp::min(expires, now_ms() + PROVISIONING_LEASE_MS)
        } else {
            expires
        };
        tx.execute(
            Query::insert()
                .into_table(peers::Entity)
                .columns([
                    peers::Column::Id,
                    peers::Column::RegistrationId,
                    peers::Column::TeamId,
                    peers::Column::UserId,
                    peers::Column::LoginSessionId,
                    peers::Column::GrantJson,
                    peers::Column::ExpiresAt,
                ])
                .values_panic([
                    auth.peer_id.clone().into(),
                    registration_id.into(),
                    team_id.into(),
                    auth.actor.user_id.clone().into(),
                    login_id.into(),
                    serde_json::to_value(auth)?.into(),
                    expires.into(),
                ]),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn peer(&self, id: &str, login_id: &str) -> Result<PeerAuthorization> {
        let row = one_query(
            &self.db,
            Query::select()
                .column(peers::Column::GrantJson)
                .from(peers::Entity)
                .and_where(Expr::col(peers::Column::Id).eq(id))
                .and_where(Expr::col(peers::Column::LoginSessionId).eq(login_id))
                .and_where(Expr::col(peers::Column::Revoked).not())
                .and_where(Expr::col(peers::Column::ExpiresAt).gt(now_ms())),
        )
        .await?;
        Ok(serde_json::from_value(row.try_get("", "grant_json")?)?)
    }
    /// Look up a login's peer for cleanup, including revoked or expired grants.
    ///
    /// This does not authorize further peer operations. Callers must still
    /// authenticate the login and check its current access to the target machine.
    pub async fn peer_for_close(&self, id: &str, login_id: &str) -> Result<PeerAuthorization> {
        let row = one_query(
            &self.db,
            Query::select()
                .column(peers::Column::GrantJson)
                .from(peers::Entity)
                .and_where(Expr::col(peers::Column::Id).eq(id))
                .and_where(Expr::col(peers::Column::LoginSessionId).eq(login_id)),
        )
        .await?;
        Ok(serde_json::from_value(row.try_get("", "grant_json")?)?)
    }
    pub async fn valid_machine_peers(&self, machine_id: &str) -> Result<Vec<PeerAuthorization>> {
        json_query(
            &self.db,
            Query::select()
                .expr_as(
                    Expr::col((peers::Entity, peers::Column::GrantJson)),
                    Alias::new("record"),
                )
                .from(peers::Entity)
                .join(
                    JoinType::InnerJoin,
                    members::Entity,
                    Expr::col((members::Entity, members::Column::TeamId))
                        .equals((peers::Entity, peers::Column::TeamId))
                        .and(
                            Expr::col((members::Entity, members::Column::UserId))
                                .equals((peers::Entity, peers::Column::UserId)),
                        ),
                )
                .join(
                    JoinType::InnerJoin,
                    logins::Entity,
                    Expr::col((logins::Entity, logins::Column::Id))
                        .equals((peers::Entity, peers::Column::LoginSessionId)),
                )
                .and_where(
                    Expr::col((peers::Entity, peers::Column::RegistrationId))
                        .eq(resource_id(machine_id)?),
                )
                .and_where(Expr::col((peers::Entity, peers::Column::Revoked)).not())
                .and_where(Expr::col((peers::Entity, peers::Column::ExpiresAt)).gt(now_ms()))
                .and_where(Expr::col((logins::Entity, logins::Column::Revoked)).not()),
        )
        .await?
        .into_iter()
        .map(|v| serde_json::from_value(v).map_err(crate::Error::from))
        .collect()
    }
    pub async fn peer_login(&self, id: &str, machine_id: &str) -> Result<String> {
        let row = one_query(
            &self.db,
            Query::select()
                .column(peers::Column::LoginSessionId)
                .from(peers::Entity)
                .and_where(Expr::col(peers::Column::Id).eq(id))
                .and_where(Expr::col(peers::Column::RegistrationId).eq(resource_id(machine_id)?))
                .and_where(Expr::col(peers::Column::Revoked).not())
                .and_where(Expr::col(peers::Column::ExpiresAt).gt(now_ms())),
        )
        .await?;
        Ok(row.try_get("", "login_session_id")?)
    }
    pub async fn revoke_peer(&self, id: &str) -> Result<Vec<PeerAuthorization>> {
        self.revoke(Expr::col(peers::Column::Id).eq(id)).await
    }
    pub async fn revoke_login_peers(&self, id: &str) -> Result<Vec<PeerAuthorization>> {
        self.revoke(Expr::col(peers::Column::LoginSessionId).eq(id))
            .await
    }
    pub async fn revoke_machine_peers(&self, id: &str) -> Result<Vec<PeerAuthorization>> {
        self.revoke(Expr::col(peers::Column::RegistrationId).eq(resource_id(id)?))
            .await
    }
    pub async fn revoke_member_peers(
        &self,
        team_id: &str,
        user_id: &str,
    ) -> Result<Vec<PeerAuthorization>> {
        self.revoke(
            Expr::col(peers::Column::TeamId)
                .eq(resource_id(team_id)?)
                .and(Expr::col(peers::Column::UserId).eq(user_id)),
        )
        .await
    }
    async fn revoke(&self, predicate: Expr) -> Result<Vec<PeerAuthorization>> {
        self.db
            .query_all(
                Query::update()
                    .table(peers::Entity)
                    .value(peers::Column::Revoked, true)
                    .and_where(Expr::col(peers::Column::Revoked).not())
                    .and_where(predicate)
                    .returning_col(peers::Column::GrantJson),
            )
            .await?
            .into_iter()
            .map(|row| Ok(serde_json::from_value(row.try_get("", "grant_json")?)?))
            .collect()
    }
}
