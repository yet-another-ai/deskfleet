//! Trusted signaling binds each exact SDP exchange to one immutable authorization.
use crate::{
    AppState, api, auth,
    config::ServerConfig,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, web};
use base64::Engine;
use deskfleet_control_store::{now_ms, policies::MachineAction, timestamp};
use deskfleet_protocol::control::{IceServer, PeerAuthorization, PeerTarget};
use hmac::{Hmac, KeyInit, Mac};
use sdp::description::{common::Attribute, session::SessionDescription};
use serde::Deserialize;
use serde_json::{Value, json};
use sha1::Sha1;
use std::io::Cursor;

mod signaling;
pub(crate) use signaling::daemon_event;
pub use signaling::{candidate, offer};

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
        .authorize_machine(&a.user.id, &b.machine_id, MachineAction::Connect)
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
        "desktop" => vec!["desktop:stream", "desktop:control"],
        "files" => vec!["files:read", "files:write"],
        "ports" => vec!["ports:forward"],
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
    let relay_denied_reason = s.store.relay_denied_reason(&b.team_id).await?;
    let relay_allowed = relay_denied_reason.is_none();
    s.store.save_peer(&authorization, &a.id, expires).await?;
    s.store.save_peer_relay_decision(&id, relay_allowed).await?;
    Ok(web::Json(
        json!({"peerId":id,"authorization":authorization,"iceServers":grant_ice_servers(&s.config,&id,expires,relay_allowed)?,"relayAllowed":relay_allowed,"relayDeniedReason":relay_denied_reason}),
    ))
}
fn grant_ice_servers(
    config: &ServerConfig,
    peer_id: &str,
    expires: i64,
    relay_allowed: bool,
) -> Result<Vec<IceServer>> {
    if relay_allowed {
        return ice_servers(config, peer_id, expires);
    }
    let mut direct = config.clone();
    direct.turn_urls.clear();
    ice_servers(&direct, peer_id, expires)
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
        .authorize_machine(&a.user.id, &p.target_machine.id, MachineAction::Connect)
        .await?;
    Ok(p)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Start {
    display_id: Value,
    fps: Option<u32>,
    bitrate_bps: Option<u32>,
    #[serde(default)]
    control: bool,
}
pub async fn start(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
    b: web::Json<Start>,
) -> Result<web::Json<Value>> {
    let authorization = authorize(&req, &s, &p).await?;
    if authorization.purpose != "desktop"
        || !authorization
            .actions
            .iter()
            .any(|action| action == "desktop:stream")
        || (b.control
            && !authorization
                .actions
                .iter()
                .any(|action| action == "desktop:control"))
    {
        return Err(ApiError::forbidden());
    }
    Ok(web::Json(s.hub.request(&authorization.target_machine.id,"peer.start",json!({"peerId":p.as_str(),"displayId":b.display_id,"fps":b.fps,"bitrateBps":b.bitrate_bps,"control":b.control}),None).await?))
}
pub async fn close(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
) -> Result<web::Json<Value>> {
    let actor = auth::user(&req, &s).await?;
    // A prior revocation or expiry must not skip the daemon's cleanup receipt.
    // This lookup remains bound to the original login and current machine access.
    let authorization = s.store.peer_for_close(&p, &actor.id).await?;
    s.store
        .authorize_machine(
            &actor.user.id,
            &authorization.target_machine.id,
            MachineAction::Connect,
        )
        .await?;
    let peers = s.store.revoke_peer(&p).await?;
    s.hub.revoke(peers, "closed").await?;
    // Desktop reconnects can acquire exclusive native input. Revocation delivery
    // alone does not acknowledge that the previous controller released its keys.
    if authorization.purpose == "desktop" {
        s.hub
            .request(
                &authorization.target_machine.id,
                "peer.close",
                json!({"peerId": p.as_str()}),
                None,
            )
            .await?;
    }
    Ok(web::Json(json!({})))
}

#[cfg(test)]
#[path = "peers/close_tests.rs"]
mod close_tests;

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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    fn config(
        stun_urls: Vec<String>,
        turn_urls: Vec<String>,
        turn_secret: Option<&str>,
    ) -> ServerConfig {
        ServerConfig {
            bind_addr: "127.0.0.1:8080".parse().unwrap(),
            database_url: "postgres://unused".into(),
            public_url: "http://127.0.0.1:8080".into(),
            web_origins: vec![],
            auth: crate::auth::config::AuthConfig::development("http://127.0.0.1:8080"),
            billing: Default::default(),
            stun_urls,
            turn_urls,
            turn_secret: turn_secret.map(str::to_owned),
            turn_usage_redis_url: None,
        }
    }
    #[test]
    fn ice_servers_advertise_configured_stun_and_turn_lists() {
        let servers = ice_servers(
            &config(
                vec![
                    "stun:stun.example.com:3478".into(),
                    "stuns:stun.example.com:5349".into(),
                ],
                vec![
                    "turn:turn.example.com:3478?transport=udp".into(),
                    "turn:turn.example.com:3478?transport=tcp".into(),
                ],
                Some("shared-secret"),
            ),
            "peer-1",
            1_700_000_000_000,
        )
        .unwrap();
        assert_eq!(servers.len(), 2);
        assert_eq!(
            servers[0].urls,
            vec![
                "stun:stun.example.com:3478".to_owned(),
                "stuns:stun.example.com:5349".to_owned()
            ]
        );
        assert!(servers[0].username.is_none());
        assert!(servers[0].credential.is_none());
        assert_eq!(
            servers[1].urls,
            vec![
                "turn:turn.example.com:3478?transport=udp".to_owned(),
                "turn:turn.example.com:3478?transport=tcp".to_owned()
            ]
        );
        assert_eq!(servers[1].username.as_deref(), Some("1700000000:peer-1"));
        assert!(
            servers[1]
                .credential
                .as_ref()
                .is_some_and(|c| !c.is_empty())
        );
    }
    #[test]
    fn ice_servers_omit_entries_when_lists_are_empty() {
        assert!(
            ice_servers(&config(vec![], vec![], None), "peer", 1)
                .unwrap()
                .is_empty()
        );
        let stun_only = ice_servers(
            &config(vec!["stun:stun.example.com:3478".into()], vec![], None),
            "peer",
            1,
        )
        .unwrap();
        assert_eq!(stun_only.len(), 1);
        assert!(stun_only[0].credential.is_none());
    }
    #[test]
    fn desktop_control_requires_an_explicit_boolean() {
        let viewing: Start = serde_json::from_value(json!({"displayId": 1})).unwrap();
        assert!(!viewing.control);
        let controlling: Start =
            serde_json::from_value(json!({"displayId": 1, "control": true})).unwrap();
        assert!(controlling.control);
        assert!(
            serde_json::from_value::<Start>(json!({"displayId": 1, "control": "true"})).is_err()
        );
    }
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
