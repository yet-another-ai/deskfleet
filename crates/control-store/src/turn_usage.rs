use crate::{ControlStore, Error, Result, one, resource_id, sql};
use sea_orm::ConnectionTrait;

/// The allocation socket whose counters coturn reported.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TurnUsageSide {
    Client,
    Peer,
}

impl TurnUsageSide {
    fn as_str(self) -> &'static str {
        match self {
            Self::Client => "client",
            Self::Peer => "peer",
        }
    }
}

/// One received coturn usage notification. Byte counts are reported deltas.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnUsage {
    pub peer_id: String,
    pub realm: String,
    pub allocation_id: String,
    pub side: TurnUsageSide,
    pub received_bytes: i64,
    pub sent_bytes: i64,
    /// Receiver timestamp in Unix milliseconds.
    pub collected_at: i64,
}

impl ControlStore {
    /// Return a Team's cumulative TURN outbound bytes as a decimal string.
    ///
    /// Both allocation socket sides contribute their sent bytes. Received bytes
    /// are excluded, and the decimal result preserves PostgreSQL's numeric sum.
    ///
    /// # Errors
    /// Returns an error for nonmembers, an invalid Team ID, or a database failure.
    pub async fn team_relayed_bytes(&self, user_id: &str, team_id: &str) -> Result<String> {
        self.team_role(user_id, team_id).await?;
        let row = one(
            &self.db,
            "SELECT COALESCE(SUM(sent_bytes),0)::text AS relayed_bytes FROM cp_turn_usage WHERE team_id=$1",
            vec![resource_id(team_id)?.into()],
        )
        .await?;
        Ok(row.try_get("", "relayed_bytes")?)
    }

    /// Record a usage event against the Team stored in its peer authorization.
    ///
    /// Returns false for an unknown peer. Each notification counts separately;
    /// expired and revoked peers retain their original Team attribution.
    ///
    /// # Errors
    /// Returns an error for invalid input or a database failure.
    pub async fn record_turn_usage(&self, usage: &TurnUsage) -> Result<bool> {
        if usage.peer_id.is_empty()
            || usage.allocation_id.is_empty()
            || usage.received_bytes < 0
            || usage.sent_bytes < 0
            || usage.collected_at < 0
        {
            return Err(Error::Invalid("invalid TURN usage event"));
        }
        let values = vec![
            usage.peer_id.as_str().into(),
            usage.realm.as_str().into(),
            usage.allocation_id.as_str().into(),
            usage.side.as_str().into(),
            usage.received_bytes.into(),
            usage.sent_bytes.into(),
            usage.collected_at.into(),
        ];
        let inserted = self.db.execute_raw(sql(
            "INSERT INTO cp_turn_usage(peer_id,team_id,realm,allocation_id,side,received_bytes,sent_bytes,collected_at) SELECT id,team_id,$2,$3,$4,$5,$6,$7 FROM cp_peers WHERE id=$1",
            values,
        )).await?;
        Ok(inserted.rows_affected() == 1)
    }
}
