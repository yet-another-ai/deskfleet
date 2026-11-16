//! Shared SDP exchanges without retaining SQL locks while awaiting a daemon.

use super::{
    authorize_webrtc, binding, issued_ice_servers, normalize_candidate, registration,
    revoke_failed_setup,
};
use crate::{
    AppState,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, http::StatusCode, web};
use deskfleet_control_store::{PeerCandidateState, PeerOfferState};
use deskfleet_protocol::control::{ControlMessage, PeerAuthorization};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Offer {
    sdp: String,
    #[serde(default)]
    options: Value,
}

pub async fn offer(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
    b: web::Json<Offer>,
) -> Result<web::Json<Value>> {
    let authorization = authorize_webrtc(&req, &s, &p).await?;
    binding(&b.sdp)?;
    deskfleet_control_store::signaling_limits::options(&b.options)?;
    let state = s.store.prepare_peer_offer(&p, &b.sdp, &b.options).await?;
    let answer = match state {
        PeerOfferState::Answered(answer) => Ok(answer),
        PeerOfferState::Start | PeerOfferState::Waiting => {
            negotiate(&s, &p, &b, &authorization, state).await
        }
    };
    // The grant can be revoked while the first request waits on another host.
    let answer = match answer {
        Ok(answer) => authorize_webrtc(&req, &s, &p).await.map(|_| answer),
        failed => failed,
    };
    if let Err(error) = &answer
        && withdrawn(error)
    {
        // That revocation's notice can reach the daemon before this offer creates
        // its peer and close nothing. Notify again now that the offer was answered
        // or abandoned.
        revoke_failed_setup(&s, &authorization, "negotiation_failed").await?;
    }
    Ok(web::Json(json!({"sdp":answer?})))
}

/// Login, access, and grant checks that fail once the grant has been withdrawn.
fn withdrawn(error: &ApiError) -> bool {
    matches!(
        error.status,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
    )
}

/// Exchange or await the daemon's answer, including one another instance committed.
async fn negotiate(
    s: &AppState,
    peer_id: &str,
    offer: &Offer,
    authorization: &PeerAuthorization,
    state: PeerOfferState,
) -> Result<String> {
    let result = tokio::time::timeout(NEGOTIATION_TIMEOUT, async {
        if state == PeerOfferState::Start {
            exchange_offer(s, peer_id, offer, authorization).await
        } else {
            wait_answer(s, peer_id).await
        }
    })
    .await
    .unwrap_or_else(|_| Err(ApiError::bad("negotiation timed out; create a new peer")));
    let error = match result {
        Ok(answer) => return Ok(answer),
        Err(error) => error,
    };
    if let Some(answer) = recover_committed_answer(s, peer_id).await? {
        return Ok(answer);
    }
    if s.store.fail_peer_offer(peer_id).await? {
        // The caller notifies a withdrawn grant once.
        if !withdrawn(&error) {
            revoke_failed_setup(s, authorization, "negotiation_failed").await?;
        }
        return Err(error);
    }
    // Answer committed between the first check and fail.
    recover_committed_answer(s, peer_id).await?.ok_or(error)
}

/// Shared negotiations may finish on another instance while this request fails.
async fn recover_committed_answer(s: &AppState, peer_id: &str) -> Result<Option<String>> {
    match s.store.peer_answer(peer_id).await {
        Ok(answer) => Ok(answer),
        Err(deskfleet_control_store::Error::Invalid(_)) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn exchange_offer(
    s: &AppState,
    peer_id: &str,
    offer: &Offer,
    authorization: &PeerAuthorization,
) -> Result<String> {
    let ice_servers = issued_ice_servers(s, authorization).await?;
    let registration_id = registration(s, authorization).await?;
    let result = s
        .hub
        .request(
            &registration_id,
            "peer.offer",
            json!({
                "peerId": peer_id, "sdp": offer.sdp, "authorization": authorization,
                "iceServers": ice_servers,
                "options": offer.options,
            }),
            Some(authorization.actor.clone()),
        )
        .await?;
    let answer = result["sdp"]
        .as_str()
        .ok_or_else(|| ApiError::bad("daemon returned no SDP answer"))?;
    binding(answer)?;
    let pending = s.store.finish_peer_offer(peer_id, answer).await?;
    for candidate in pending {
        let candidate = normalize_candidate(&offer.sdp, candidate)?;
        s.store.peer_login(peer_id, &registration_id).await?;
        send_candidate(s, peer_id, &registration_id, candidate).await?;
    }
    Ok(answer.into())
}

async fn wait_answer(s: &AppState, peer_id: &str) -> Result<String> {
    loop {
        if let Some(answer) = s.store.peer_answer(peer_id).await? {
            return Ok(answer);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    candidate: Value,
}

pub async fn candidate(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
    b: web::Json<Candidate>,
) -> Result<web::Json<Value>> {
    let authorization = authorize_webrtc(&req, &s, &p).await?;
    deskfleet_control_store::signaling_limits::candidate(&b.candidate)?;
    let text = b
        .candidate
        .get("candidate")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad("candidate text missing"))?;
    if text.len() > 16384 {
        return Err(ApiError::bad("ICE candidate too large"));
    }
    if let PeerCandidateState::Ready { offer } =
        s.store.queue_peer_candidate(&p, &b.candidate).await?
    {
        let candidate = normalize_candidate(&offer, b.candidate.clone())?;
        send_candidate(&s, &p, &registration(&s, &authorization).await?, candidate).await?;
    }
    Ok(web::Json(json!({})))
}

async fn send_candidate(
    s: &AppState,
    peer_id: &str,
    machine: &str,
    candidate: Value,
) -> Result<()> {
    s.hub
        .request(
            machine,
            "peer.candidate",
            json!({"peerId":peer_id,"candidate":candidate}),
            None,
        )
        .await?;
    Ok(())
}

/// Run away from the socket reader: an ICE event can precede the offer response
/// that the same reader must deliver. Other instances observe the shared answer.
pub(crate) async fn daemon_event(
    s: &AppState,
    machine: &str,
    connection: &str,
    peer_id: String,
    mut event: Value,
) -> Result<()> {
    super::events::validate(&event)?;
    if !s
        .store
        .auth_rate_limit(&format!("peer-events:{machine}"), 128, 1000)
        .await?
    {
        return Err(ApiError::bad("peer event rate exceeded"));
    }
    s.store.peer_login(&peer_id, machine).await?;
    if !s.hub.is_current(machine, connection).await {
        return Err(ApiError::unavailable());
    }
    if event["kind"] == "iceCandidate" {
        let answer = tokio::time::timeout(NEGOTIATION_TIMEOUT, wait_answer(s, &peer_id))
            .await
            .map_err(|_| ApiError::bad("peer answer unavailable; create a new peer"))??;
        event["candidate"] = normalize_candidate(&answer, event["candidate"].take())?;
    }
    if !s.hub.is_current(machine, connection).await {
        return Err(ApiError::unavailable());
    }
    let login = s.store.peer_login(&peer_id, machine).await?;
    let closed = event["kind"] == "stateChanged"
        && matches!(event["state"].as_str(), Some("closed" | "failed"));
    let delivered = s
        .hub
        .send_client(
            &login,
            ControlMessage::PeerEvent {
                peer_id: peer_id.clone(),
                event: event.clone(),
            },
        )
        .await;
    // Revoke even when the client notify fails so heartbeat reconcile cannot
    // keep advertising a peer the daemon already shut down.
    if closed {
        let peers = s.store.revoke_peer(&peer_id).await?;
        s.hub.revoke(peers, "peer_closed").await?;
    }
    delivered
}

#[cfg(test)]
#[path = "shared_tests.rs"]
mod tests;
