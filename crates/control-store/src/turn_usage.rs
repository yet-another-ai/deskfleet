use crate::entities::{
    cp_peers as peers, cp_turn_collector as collector, cp_turn_usage as usage_rows,
};
use crate::{ControlStore, Error, Result};
use sea_orm::ConnectionTrait;
use sea_orm::sea_query::{Cond, Expr, ExprTrait, Query};

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
    /// Record a usage event against the Team stored in its peer authorization.
    ///
    /// Returns false for an unknown peer. Each notification counts separately;
    /// expired and revoked peers retain their original Team attribution.
    ///
    /// # Errors
    /// Returns an error for invalid input or a database failure.
    pub async fn record_turn_usage(&self, usage: &TurnUsage) -> Result<bool> {
        self.record_turn_usage_owned(usage, None).await
    }

    /// The collector lease fences concurrent server replicas. Provider Pub/Sub
    /// still cannot recover traffic missed while every collector was disconnected.
    pub async fn record_turn_usage_owned(
        &self,
        usage: &TurnUsage,
        owner: Option<&str>,
    ) -> Result<bool> {
        if usage.peer_id.is_empty()
            || usage.allocation_id.is_empty()
            || usage.received_bytes < 0
            || usage.sent_bytes < 0
            || usage.collected_at < 0
        {
            return Err(Error::Invalid("invalid TURN usage event"));
        }
        let lease = Query::select()
            .expr(Expr::val(1))
            .from(collector::Entity)
            .and_where(Expr::col(collector::Column::Singleton))
            .and_where(Expr::col(collector::Column::Owner).eq(owner))
            .and_where(Expr::col(collector::Column::LeaseUntil).gt(crate::now_ms()))
            .to_owned();
        let source = Query::select()
            .columns([peers::Column::Id, peers::Column::TeamId])
            .expr(Expr::val(usage.realm.as_str()))
            .expr(Expr::val(usage.allocation_id.as_str()))
            .expr(Expr::val(usage.side.as_str()))
            .expr(Expr::val(usage.received_bytes))
            .expr(Expr::val(usage.sent_bytes))
            .expr(Expr::val(usage.collected_at))
            .from(peers::Entity)
            .and_where(Expr::col(peers::Column::Id).eq(usage.peer_id.as_str()))
            .cond_where(
                Cond::any()
                    .add(Expr::val(owner.is_none()))
                    .add(Expr::exists(lease)),
            )
            .to_owned();
        let inserted = self
            .db
            .execute(
                Query::insert()
                    .into_table(usage_rows::Entity)
                    .columns([
                        usage_rows::Column::PeerId,
                        usage_rows::Column::TeamId,
                        usage_rows::Column::Realm,
                        usage_rows::Column::AllocationId,
                        usage_rows::Column::Side,
                        usage_rows::Column::ReceivedBytes,
                        usage_rows::Column::SentBytes,
                        usage_rows::Column::CollectedAt,
                    ])
                    .select_from(source)
                    .expect("eight selected TURN usage columns"),
            )
            .await?;
        Ok(inserted.rows_affected() == 1)
    }
}
