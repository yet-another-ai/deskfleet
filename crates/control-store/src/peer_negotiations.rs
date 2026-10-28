//! Short shared signaling transactions. Daemon RPC never holds a database lock.

use crate::{ControlStore, Error, Result, now_ms, one, sql};
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
            tx.execute_raw(sql(
                "UPDATE cp_peer_negotiations SET offer=$2,options=$3,started_at=$4 WHERE peer_id=$1",
                vec![peer_id.into(), offer.into(), options.clone().into(), now_ms().into()],
            ))
            .await?;
            PeerOfferState::Start
        };
        tx.commit().await?;
        Ok(state)
    }

    /// Polling readers use no row lock and release their connection each time.
    pub async fn peer_answer(&self, peer_id: &str) -> Result<Option<String>> {
        let row = one(
            &self.db,
            "SELECT n.answer,n.started_at,n.failed FROM cp_peer_negotiations n JOIN cp_peers p ON p.id=n.peer_id WHERE p.id=$1 AND NOT p.revoked AND p.expires_at>$2",
            vec![peer_id.into(), now_ms().into()],
        )
        .await?;
        check_attempt(&row)?;
        Ok(row.try_get("", "answer")?)
    }

    /// Commit the answer and take all candidates buffered before it atomically.
    pub async fn finish_peer_offer(&self, peer_id: &str, answer: &str) -> Result<Vec<Value>> {
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
        tx.execute_raw(sql(
            "UPDATE cp_peer_negotiations SET answer=$2,pending='[]' WHERE peer_id=$1",
            vec![peer_id.into(), answer.into()],
        ))
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
            tx.execute_raw(sql(
                "UPDATE cp_peer_negotiations SET pending=pending || $2::jsonb WHERE peer_id=$1",
                vec![peer_id.into(), json!([candidate]).into()],
            ))
            .await?;
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
            .execute_raw(sql(
                "UPDATE cp_peer_negotiations SET failed=TRUE,pending='[]' WHERE peer_id=$1 AND answer IS NULL",
                vec![peer_id.into()],
            ))
            .await?
            .rows_affected()
            == 1)
    }
}

/// Every writer locks the peer first, serializing with revocation as well as
/// other negotiation writers. No external I/O occurs inside this transaction.
async fn negotiation(tx: &DatabaseTransaction, peer_id: &str) -> Result<QueryResult> {
    one(
        tx,
        "SELECT id FROM cp_peers WHERE id=$1 AND NOT revoked AND expires_at>$2 FOR UPDATE",
        vec![peer_id.into(), now_ms().into()],
    )
    .await?;
    tx.execute_raw(sql(
        "INSERT INTO cp_peer_negotiations(peer_id) VALUES($1) ON CONFLICT DO NOTHING",
        vec![peer_id.into()],
    ))
    .await?;
    one(
        tx,
        "SELECT offer,options,answer,pending,started_at,failed FROM cp_peer_negotiations WHERE peer_id=$1 FOR UPDATE",
        vec![peer_id.into()],
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
