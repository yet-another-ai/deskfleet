//! Short shared signaling transactions. Daemon RPC never holds a database lock.

use crate::entities::{cp_peer_negotiations as negotiations, cp_peers as peers};
use crate::{ControlStore, Error, Result, now_ms, one_query};
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{Alias, Expr, ExprTrait, Func, JoinType, LockType, OnConflict, Query};
use sea_orm::{ConnectionTrait, DatabaseTransaction, QueryResult, TransactionTrait};
use serde_json::{Value, json};

const OFFER_TIMEOUT_MS: i64 = 60_000;
const FAILED: &str = "previous negotiation failed; create a new peer";

#[derive(Debug, PartialEq)]
pub enum PeerOfferState {
    Start,
    Waiting,
    Answered(String),
}

#[derive(Debug, PartialEq)]
pub enum PeerCandidateState {
    Queued,
    Ready { offer: String },
}

impl ControlStore {
    /// Only the first caller starts the daemon offer. Retries share its result.
    pub async fn prepare_peer_offer(
        &self,
        peer_id: &str,
        offer: &str,
        options: &Value,
    ) -> Result<PeerOfferState> {
        crate::signaling_limits::options(options)?;
        if offer.len() > crate::signaling_limits::SDP_BYTES {
            return Err(Error::Invalid("SDP exceeds supported limit"));
        }
        let tx = self.db.begin().await?;
        let row = negotiation(&tx, peer_id).await?;
        if row.try_get::<bool>("", "failed")? {
            return Err(Error::Invalid(FAILED));
        }
        let state = if let Some(previous) = row.try_get::<Option<String>>("", "offer")? {
            if previous != offer || row.try_get::<Value>("", "options")? != *options {
                return Err(Error::Invalid(
                    "peer descriptions and options are immutable",
                ));
            }
            row.try_get::<Option<String>>("", "answer")?
                .map_or(PeerOfferState::Waiting, PeerOfferState::Answered)
        } else {
            tx.execute(
                Query::update()
                    .table(negotiations::Entity)
                    .value(negotiations::Column::Offer, offer)
                    .value(negotiations::Column::Options, options.clone())
                    .value(negotiations::Column::StartedAt, now_ms())
                    .and_where(Expr::col(negotiations::Column::PeerId).eq(peer_id)),
            )
            .await?;
            PeerOfferState::Start
        };
        tx.commit().await?;
        Ok(state)
    }

    /// Polling readers use no row lock and release their connection each time.
    pub async fn peer_answer(&self, peer_id: &str) -> Result<Option<String>> {
        let row = one_query(
            &self.db,
            Query::select()
                .columns(
                    [
                        negotiations::Column::Answer,
                        negotiations::Column::StartedAt,
                        negotiations::Column::Failed,
                    ]
                    .map(|c| (negotiations::Entity, c)),
                )
                .from(negotiations::Entity)
                .join(
                    JoinType::InnerJoin,
                    peers::Entity,
                    Expr::col((peers::Entity, peers::Column::Id))
                        .equals((negotiations::Entity, negotiations::Column::PeerId)),
                )
                .and_where(Expr::col((peers::Entity, peers::Column::Id)).eq(peer_id))
                .and_where(Expr::col((peers::Entity, peers::Column::Revoked)).not())
                .and_where(Expr::col((peers::Entity, peers::Column::ExpiresAt)).gt(now_ms())),
        )
        .await?;
        check_attempt(&row)?;
        Ok(row.try_get("", "answer")?)
    }

    /// Commit the answer and take all candidates buffered before it atomically.
    pub async fn finish_peer_offer(&self, peer_id: &str, answer: &str) -> Result<Vec<Value>> {
        if answer.len() > crate::signaling_limits::SDP_BYTES {
            return Err(Error::Invalid("SDP exceeds supported limit"));
        }
        let tx = self.db.begin().await?;
        let row = negotiation(&tx, peer_id).await?;
        check_attempt(&row)?;
        if row.try_get::<Option<String>>("", "offer")?.is_none() {
            return Err(Error::Invalid("peer offer unavailable"));
        }
        if row.try_get::<Option<String>>("", "answer")?.is_some() {
            return Err(Error::Invalid("peer answer is already committed"));
        }
        let pending = serde_json::from_value(row.try_get("", "pending")?)?;
        tx.execute(
            Query::update()
                .table(negotiations::Entity)
                .value(negotiations::Column::Answer, answer)
                .value(negotiations::Column::Pending, json!([]))
                .and_where(Expr::col(negotiations::Column::PeerId).eq(peer_id)),
        )
        .await?;
        tx.commit().await?;
        Ok(pending)
    }

    /// Candidates remain buffered until the daemon's answer is committed.
    pub async fn queue_peer_candidate(
        &self,
        peer_id: &str,
        candidate: &Value,
    ) -> Result<PeerCandidateState> {
        crate::signaling_limits::candidate(candidate)?;
        let tx = self.db.begin().await?;
        let row = negotiation(&tx, peer_id).await?;
        check_attempt(&row)?;
        let state = if row.try_get::<Option<String>>("", "answer")?.is_some() {
            PeerCandidateState::Ready {
                offer: row
                    .try_get::<Option<String>>("", "offer")?
                    .ok_or(Error::Invalid("peer offer unavailable"))?,
            }
        } else {
            let pending: Value = row.try_get("", "pending")?;
            if pending
                .as_array()
                .is_none_or(|pending| pending.len() >= 256)
            {
                return Err(Error::Invalid("too many pending candidates"));
            }
            let updated = tx
                .execute(
                    Query::update()
                        .table(negotiations::Entity)
                        .value(
                            negotiations::Column::Pending,
                            Expr::col(negotiations::Column::Pending)
                                .concat(Expr::val(json!([candidate])).cast_as(Alias::new("jsonb"))),
                        )
                        .and_where(Expr::col(negotiations::Column::PeerId).eq(peer_id))
                        .and_where(
                            Expr::expr(
                                Func::cust(Alias::new("octet_length")).arg(
                                    Expr::col(negotiations::Column::Pending)
                                        .concat(
                                            Expr::val(json!([candidate]))
                                                .cast_as(Alias::new("jsonb")),
                                        )
                                        .cast_as(Alias::new("text")),
                                ),
                            )
                            .lte(crate::signaling_limits::PENDING_BYTES as i64),
                        ),
                )
                .await?;
            if updated.rows_affected() == 0 {
                return Err(Error::Invalid("pending ICE candidates exceed byte budget"));
            }
            PeerCandidateState::Queued
        };
        tx.commit().await?;
        Ok(state)
    }

    /// Marks an incomplete attempt failed. Returns false when an answer is already
    /// committed so waiters and post-answer ICE errors cannot tear it down.
    pub async fn fail_peer_offer(&self, peer_id: &str) -> Result<bool> {
        Ok(self
            .db
            .execute(
                Query::update()
                    .table(negotiations::Entity)
                    .value(negotiations::Column::Failed, true)
                    .value(negotiations::Column::Pending, json!([]))
                    .and_where(Expr::col(negotiations::Column::PeerId).eq(peer_id))
                    .and_where(Expr::col(negotiations::Column::Answer).is_null()),
            )
            .await?
            .rows_affected()
            == 1)
    }
}

/// Every writer locks the peer first, serializing with revocation as well as
/// other negotiation writers. No external I/O occurs inside this transaction.
async fn negotiation(tx: &DatabaseTransaction, peer_id: &str) -> Result<QueryResult> {
    one_query(
        tx,
        Query::select()
            .column(peers::Column::Id)
            .from(peers::Entity)
            .and_where(Expr::col(peers::Column::Id).eq(peer_id))
            .and_where(Expr::col(peers::Column::Revoked).not())
            .and_where(Expr::col(peers::Column::ExpiresAt).gt(now_ms()))
            .lock(LockType::Update),
    )
    .await?;
    tx.execute(
        Query::insert()
            .into_table(negotiations::Entity)
            .columns([negotiations::Column::PeerId])
            .values_panic([peer_id.into()])
            .on_conflict(OnConflict::new().do_nothing().to_owned()),
    )
    .await?;
    one_query(
        tx,
        Query::select()
            .columns([
                negotiations::Column::Offer,
                negotiations::Column::Options,
                negotiations::Column::Answer,
                negotiations::Column::Pending,
                negotiations::Column::StartedAt,
                negotiations::Column::Failed,
            ])
            .from(negotiations::Entity)
            .and_where(Expr::col(negotiations::Column::PeerId).eq(peer_id))
            .lock(LockType::Update),
    )
    .await
}

fn check_attempt(row: &QueryResult) -> Result<()> {
    if row.try_get::<bool>("", "failed")?
        || (row.try_get::<Option<String>>("", "answer")?.is_none()
            && row
                .try_get::<Option<i64>>("", "started_at")?
                .is_some_and(|started| now_ms() - started >= OFFER_TIMEOUT_MS))
    {
        return Err(Error::Invalid(FAILED));
    }
    Ok(())
}
