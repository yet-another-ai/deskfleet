//! Trusted signaling binds each exact SDP exchange to one immutable authorization.
use crate::{
    AppState, api, auth,
    config::ServerConfig,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, web};
use base64::Engine;
use deskfleet_control_store::{now_ms, timestamp};
use deskfleet_protocol::control::{IceServer, PeerAuthorization, PeerTarget};
use hmac::{Hmac, KeyInit, Mac};
use sdp::description::{common::Attribute, session::SessionDescription};
use serde::Deserialize;
use serde_json::{Value, json};
use sha1::Sha1;
use std::{collections::HashMap, io::Cursor, sync::Arc};
use tokio::sync::Mutex;

type NegotiationHandle = Arc<Mutex<Negotiation>>;
#[derive(Default)]
pub struct Negotiations {
    records: Mutex<HashMap<String, (i64, NegotiationHandle)>>,
}
#[derive(Default)]
struct Negotiation {
    offer: Option<String>,
    answer: Option<String>,
    options: Value,
    pending: Vec<Value>,
}
impl Negotiations {
    async fn get(&self, id: &str) -> Result<NegotiationHandle> {
        self.records
            .lock()
            .await
            .get(id)
            .map(|(_, record)| record.clone())
            .ok_or_else(|| ApiError::bad("peer negotiation is unavailable; create a new peer"))
    }
    async fn insert(&self, id: &str, expires: i64) {
        let mut records = self.records.lock().await;
        records.retain(|_, (expiry, _)| *expiry > now_ms());
        records.insert(
            id.into(),
            (expires, Arc::new(Mutex::new(Negotiation::default()))),
        );
    }
    pub async fn remove(&self, id: &str) {
        self.records.lock().await.remove(id);
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create {
    team_id: String,
    machine_id: String,
    purpose: String,
}
pub async fn create(
    req: HttpRequest,
    s: web::Data<AppState>,
    b: web::Json<Create>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    let machine = s
        .store
        .authorized_machine(&a.user.id, &b.machine_id)
        .await?;
    if machine.team_id != b.team_id {
        return Err(ApiError::forbidden());
    }
    if !s.hub.online(&machine.id).await {
        return Err(ApiError::unavailable());
    }
    let actions = match b.purpose.as_str() {
        "agent" => vec!["agent:read", "agent:execute", "git:read"],
        "terminal" => vec!["terminal:read", "terminal:write"],
        "desktop" => vec!["desktop:stream"],
        "files" => vec!["files:read", "files:write"],
        _ => return Err(ApiError::bad("unsupported peer purpose")),
    };
    let now = now_ms();
    let expires = now + 24 * 60 * 60 * 1000;
    let id = uuid::Uuid::new_v4().to_string();
    let authorization = PeerAuthorization {
        peer_id: id.clone(),
        server_id: s.config.public_url.clone(),
        team_id: b.team_id.clone(),
        actor: api::actor(&a),
        target_machine: PeerTarget {
            id: machine.id,
            origin_id: machine.origin_id,
            local_machine_id: machine.local_machine_id,
        },
        purpose: b.purpose.clone(),
        actions: actions.into_iter().map(str::to_owned).collect(),
        issued_at: timestamp(now),
        expires_at: timestamp(expires),
    };
    s.store.save_peer(&authorization, &a.id, expires).await?;
    s.peers.insert(&id, expires).await;
    Ok(web::Json(
        json!({"peerId":id,"authorization":authorization,"iceServers":ice_servers(&s.config,&id,expires)?}),
    ))
}
pub fn ice_servers(config: &ServerConfig, peer_id: &str, expires: i64) -> Result<Vec<IceServer>> {
    let mut servers = Vec::new();
    if !config.stun_urls.is_empty() {
        servers.push(IceServer {
            urls: config.stun_urls.clone(),
            username: None,
            credential: None,
        });
    }
    if !config.turn_urls.is_empty() {
        let key = config.turn_secret.as_ref().ok_or_else(ApiError::internal)?;
        let username = format!("{}:{peer_id}", expires / 1000);
        let mut mac =
            Hmac::<Sha1>::new_from_slice(key.as_bytes()).map_err(|_| ApiError::internal())?;
        mac.update(username.as_bytes());
        servers.push(IceServer {
            urls: config.turn_urls.clone(),
            username: Some(username),
            credential: Some(
                base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes()),
            ),
        });
    }
    Ok(servers)
}
async fn authorize(req: &HttpRequest, s: &AppState, id: &str) -> Result<PeerAuthorization> {
    let a = auth::user(req, s).await?;
    let p = s.store.peer(id, &a.id).await?;
    s.store
        .authorized_machine(&a.user.id, &p.target_machine.id)
        .await?;
    Ok(p)
}
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
    let authorization = authorize(&req, &s, &p).await?;
    binding(&b.sdp)?;
    let record = s.peers.get(&p).await?;
    let mut record = record.lock().await;
    if let Some(old) = &record.offer {
        if old != &b.sdp || record.options != b.options {
            return Err(ApiError::bad("peer descriptions and options are immutable"));
        }
        return record
            .answer
            .as_ref()
            .map(|answer| web::Json(json!({"sdp":answer})))
            .ok_or_else(|| ApiError::bad("previous negotiation failed; create a new peer"));
    }
    record.offer = Some(b.sdp.clone());
    record.options = b.options.clone();
    let expires = chrono::DateTime::parse_from_rfc3339(&authorization.expires_at)
        .map_err(|_| ApiError::internal())?
        .timestamp_millis();
    let result=s.hub.request(&authorization.target_machine.id,"peer.offer",json!({"peerId":p.as_str(),"sdp":b.sdp,"authorization":authorization,"iceServers":ice_servers(&s.config,&p,expires)?,"options":b.options}),Some(authorization.actor.clone())).await;
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            let peers = s.store.revoke_peer(&p).await?;
            s.hub.revoke(peers, "negotiation_failed").await;
            return Err(error);
        }
    };
    let answer = result["sdp"].as_str();
    let validation = answer
        .ok_or_else(|| ApiError::bad("daemon returned no SDP answer"))
        .and_then(|answer| binding(answer).map(|_| answer));
    let answer = match validation {
        Ok(answer) => answer,
        Err(error) => {
            let peers = s.store.revoke_peer(&p).await?;
            s.hub.revoke(peers, "invalid_answer").await;
            return Err(error);
        }
    };
    record.answer = Some(answer.into());
    let pending = std::mem::take(&mut record.pending);
    for candidate in pending {
        let candidate = normalize_candidate(&b.sdp, candidate)?;
        s.hub
            .request(
                &authorization.target_machine.id,
                "peer.candidate",
                json!({"peerId":p.as_str(),"candidate":candidate}),
                None,
            )
            .await?;
    }
    Ok(web::Json(json!({"sdp":answer})))
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
    let authorization = authorize(&req, &s, &p).await?;
    let record = s.peers.get(&p).await?;
    let mut record = record.lock().await;
    let Some(offer) = &record.offer else {
        if record.pending.len() >= 256 {
            return Err(ApiError::bad("too many pending candidates"));
        }
        record.pending.push(b.candidate.clone());
        return Ok(web::Json(json!({})));
    };
    let candidate = normalize_candidate(offer, b.candidate.clone())?;
    s.hub
        .request(
            &authorization.target_machine.id,
            "peer.candidate",
            json!({"peerId":p.as_str(),"candidate":candidate}),
            None,
        )
        .await?;
    Ok(web::Json(json!({})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Start {
    display_id: Value,
    fps: Option<u32>,
    bitrate_bps: Option<u32>,
}
pub async fn start(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
    b: web::Json<Start>,
) -> Result<web::Json<Value>> {
    let authorization = authorize(&req, &s, &p).await?;
    if authorization.purpose != "desktop" {
        return Err(ApiError::forbidden());
    }
    Ok(web::Json(s.hub.request(&authorization.target_machine.id,"peer.start",json!({"peerId":p.as_str(),"displayId":b.display_id,"fps":b.fps,"bitrateBps":b.bitrate_bps}),None).await?))
}
pub async fn close(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
) -> Result<web::Json<Value>> {
    authorize(&req, &s, &p).await?;
    let peers = s.store.revoke_peer(&p).await?;
    s.hub.revoke(peers, "closed").await;
    s.peers.remove(&p).await;
    Ok(web::Json(json!({})))
}
struct MediaBinding {
    mid: Option<String>,
    ufrag: String,
}
fn attr<'a>(attrs: &'a [Attribute], key: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|a| a.key == key)
        .and_then(|a| a.value.as_deref())
}
fn binding(text: &str) -> Result<Vec<MediaBinding>> {
    if text.len() > 1024 * 1024 {
        return Err(ApiError::bad("SDP exceeds supported limit"));
    }
    let parsed = SessionDescription::unmarshal(&mut Cursor::new(text.as_bytes()))
        .map_err(|_| ApiError::bad("invalid SDP"))?;
    let mut media = Vec::new();
    let mut active = 0;
    for section in &parsed.media_descriptions {
        let fingerprints: Vec<_> = if section.attributes.iter().any(|a| a.key == "fingerprint") {
            section
                .attributes
                .iter()
                .filter(|a| a.key == "fingerprint")
                .collect()
        } else {
            parsed
                .attributes
                .iter()
                .filter(|a| a.key == "fingerprint")
                .collect()
        };
        if section.media_name.port.value != 0 {
            active += 1;
            if fingerprints.is_empty() {
                return Err(ApiError::bad("SDP transport has no fingerprint"));
            }
            for fp in fingerprints {
                let Some((algorithm, digest)) = fp.value.as_deref().and_then(|v| v.split_once(' '))
                else {
                    return Err(ApiError::bad("invalid SDP fingerprint"));
                };
                if !algorithm.eq_ignore_ascii_case("sha-256")
                    || digest.split(':').count() != 32
                    || !digest
                        .split(':')
                        .all(|b| b.len() == 2 && b.bytes().all(|v| v.is_ascii_hexdigit()))
                {
                    return Err(ApiError::bad(
                        "SDP requires SHA-256 certificate fingerprints",
                    ));
                }
            }
        }
        media.push(MediaBinding {
            mid: attr(&section.attributes, "mid").map(str::to_owned),
            ufrag: attr(&section.attributes, "ice-ufrag")
                .or_else(|| attr(&parsed.attributes, "ice-ufrag"))
                .unwrap_or("")
                .into(),
        });
    }
    if active == 0 {
        return Err(ApiError::bad("SDP has no active transport"));
    }
    Ok(media)
}
pub(crate) fn normalize_candidate(sdp: &str, mut candidate: Value) -> Result<Value> {
    let media = binding(sdp)?;
    let obj = candidate
        .as_object_mut()
        .ok_or_else(|| ApiError::bad("invalid ICE candidate"))?;
    let text = obj
        .get("candidate")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad("candidate text missing"))?;
    if text.len() > 16384 {
        return Err(ApiError::bad("ICE candidate too large"));
    }
    let mid = obj
        .get("sdpMid")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let index = obj
        .get("sdpMlineIndex")
        .and_then(Value::as_u64)
        .and_then(|i| usize::try_from(i).ok());
    let selected = if let Some(mid) = mid {
        let matching = media
            .iter()
            .position(|m| m.mid.as_deref() == Some(mid))
            .ok_or_else(|| ApiError::bad("candidate media section is not in the negotiated SDP"))?;
        if index.is_some_and(|i| i != matching) {
            return Err(ApiError::bad("candidate mid and media index disagree"));
        }
        matching
    } else {
        index.ok_or_else(|| ApiError::bad("candidate media section is missing"))?
    };
    let section = media
        .get(selected)
        .ok_or_else(|| ApiError::bad("candidate media section is not in the negotiated SDP"))?;
    obj.insert("sdpMlineIndex".into(), json!(selected));
    if obj
        .get("usernameFragment")
        .and_then(Value::as_str)
        .is_some_and(|u| u != section.ufrag)
    {
        return Err(ApiError::bad(
            "candidate belongs to another ICE negotiation",
        ));
    }
    if let Some(mid) = &section.mid {
        obj.insert("sdpMid".into(), json!(mid));
    } else {
        obj.remove("sdpMid");
    }
    if !section.ufrag.is_empty() {
        obj.insert("usernameFragment".into(), json!(section.ufrag));
    }
    Ok(candidate)
}

/// Process candidate events away from the socket reader: negotiation awaits a
/// response on that reader, so holding its lock inline would deadlock signaling.
pub(crate) async fn daemon_event(
    s: &AppState,
    machine: &str,
    connection: &str,
    peer_id: String,
    mut event: Value,
) -> Result<()> {
    s.store.peer_login(&peer_id, machine).await?;
    if event["kind"] == "iceCandidate" {
        let record = s.peers.get(&peer_id).await?;
        let record = record.lock().await;
        let answer = record
            .answer
            .as_ref()
            .ok_or_else(|| ApiError::bad("peer answer unavailable"))?;
        event["candidate"] = normalize_candidate(answer, event["candidate"].take())?;
    }
    if !s.hub.is_current(machine, connection).await {
        return Err(ApiError::unavailable());
    }
    // Recheck after waiting for negotiation, which may have failed or been revoked.
    let login = s.store.peer_login(&peer_id, machine).await?;
    s.hub
        .send_client(
            &login,
            deskfleet_protocol::control::ControlMessage::PeerEvent {
                peer_id: peer_id.clone(),
                event: event.clone(),
            },
        )
        .await;
    if event["kind"] == "stateChanged"
        && matches!(event["state"].as_str(), Some("closed" | "failed"))
    {
        let peers = s.store.revoke_peer(&peer_id).await?;
        s.hub.revoke(peers, "peer_closed").await;
        s.peers.remove(&peer_id).await;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn sdp() -> String {
        format!(
            "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 {}\r\na=ice-ufrag:one\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=mid:data\r\na=sctp-port:5000\r\n",
            vec!["AA"; 32].join(":")
        )
    }
    #[test]
    fn candidate_binds_media_and_ice_generation() {
        let native = json!({"candidate":"candidate:1 1 UDP 1 127.0.0.1 10000 typ host","sdpMid":"","sdpMlineIndex":0});
        let candidate = normalize_candidate(&sdp(), native).unwrap();
        assert_eq!(candidate["sdpMid"], "data");
        assert_eq!(candidate["usernameFragment"], "one");
        assert!(
            normalize_candidate(
                &sdp(),
                json!({"candidate":"","sdpMid":"data","sdpMlineIndex":1})
            )
            .is_err()
        );
        assert!(
            normalize_candidate(
                &sdp(),
                json!({"candidate":"","sdpMlineIndex":0,"usernameFragment":"other"})
            )
            .is_err()
        );
        assert!(binding(&sdp().replace("sha-256", "sha-1")).is_err());
        assert!(binding("invalid").is_err());
    }
}
