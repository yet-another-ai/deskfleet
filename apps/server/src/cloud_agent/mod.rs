//! Authenticated Team gateway to the private Super Agent runtime.
mod client;
mod content;
mod rollout;

use crate::{
    AppState, auth,
    error::{ApiError, Result},
};
use actix_web::{
    HttpRequest, HttpResponse, error::JsonPayloadError, http::StatusCode,
    middleware::DefaultHeaders, web,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
pub(crate) use client::EveClient;
use content::Message;
use deskfleet_control_store::{CloudPrewarm, billing::CloudTokenPeriod, policies::TeamAction};
pub(crate) use rollout::Rollout;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::time::Duration;

pub(crate) fn configure(config: &mut web::ServiceConfig) {
    config.service(
        web::scope("/teams/{teamId}/super-agent")
            .wrap(DefaultHeaders::new().add(("Cache-Control", "no-store")))
            .route("/availability", web::get().to(availability))
            .route("/sessions", web::get().to(list))
            .route("/sessions", web::post().to(create))
            .route("/sessions/{sessionId}/messages", web::post().to(message))
            .route("/sessions/{sessionId}/stream", web::get().to(stream))
            .route("/usage", web::get().to(usage)),
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    operation_id: String,
    #[serde(default, deserialize_with = "Message::present")]
    message: Option<Message>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MessageRequest {
    operation_id: String,
    message: Message,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EveDelivery<'a> {
    message: &'a Message,
    idempotency_key: &'a str,
}

// Allow a 25 MiB eve attachment after base64 encoding, plus the JSON envelope.
const MAX_MESSAGE_BODY: usize = 35 * 1024 * 1024;

/// Read attachment bytes only after authenticating and checking the Team gate.
async fn read_body<T: DeserializeOwned>(req: &HttpRequest, body: web::Payload) -> Result<T> {
    web::JsonBody::new(req, &mut body.into_inner(), None, true)
        .limit(MAX_MESSAGE_BODY)
        .await
        .map_err(|error| match error {
            JsonPayloadError::OverflowKnownLength { .. } | JsonPayloadError::Overflow { .. } => {
                ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "invalid_request",
                    "Super Agent request exceeds 35 MiB",
                )
            }
            _ => ApiError::bad("invalid Super Agent JSON request"),
        })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Created {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Delivered {
    delivery_id: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StreamQuery {
    #[serde(default)]
    start_index: u64,
}

async fn rollout_for_member(
    req: &HttpRequest,
    state: &AppState,
    team: &str,
    action: TeamAction,
) -> Result<(String, bool)> {
    let actor = auth::user(req, state).await?;
    state
        .store
        .authorize_team(&actor.user.id, team, action)
        .await?;
    let team_id = deskfleet_control_store::resource_id(team)?;
    let enabled = state.super_agent_rollout.enabled(&actor.user, team_id);
    Ok((actor.user.id, enabled))
}

async fn availability(
    req: HttpRequest,
    state: web::Data<AppState>,
    team: web::Path<String>,
) -> Result<HttpResponse> {
    let (_, enabled) = rollout_for_member(&req, &state, &team, TeamAction::Read).await?;
    Ok(HttpResponse::Ok().json(json!({ "enabled": enabled })))
}

async fn authorize(
    req: &HttpRequest,
    state: &AppState,
    team: &str,
    action: TeamAction,
) -> Result<String> {
    let (user_id, enabled) = rollout_for_member(req, state, team, action).await?;
    if !enabled {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "super_agent_disabled",
            "Super Agent is disabled",
        ));
    }
    Ok(user_id)
}

fn runtime(state: &AppState) -> Result<&EveClient> {
    state.eve.as_ref().ok_or_else(client::unavailable)
}

fn hash(parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part.as_bytes());
    }
    URL_SAFE_NO_PAD.encode(digest.finalize())
}

fn request_key(user: &str, team: &str, operation: &str) -> Result<String> {
    let id = uuid::Uuid::parse_str(operation)
        .map_err(|_| ApiError::bad("operationId must be a UUID"))?;
    let team = deskfleet_control_store::resource_id(team)?;
    Ok(hash(&[user, &team.to_string(), &id.to_string()]))
}

async fn period(state: &AppState, team: &str) -> Result<CloudTokenPeriod> {
    Ok(state.store.cloud_token_period(team).await?)
}

async fn require_session(state: &AppState, team: &str, session: &str) -> Result<()> {
    if !client::valid_segment(session) || !state.store.owns_cloud_session(team, session).await? {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "Super Agent session was not found",
        ));
    }
    Ok(())
}

async fn list(
    req: HttpRequest,
    state: web::Data<AppState>,
    team: web::Path<String>,
) -> Result<HttpResponse> {
    authorize(&req, &state, &team, TeamAction::Read).await?;
    let sessions = state.store.cloud_sessions(&team).await?;
    Ok(HttpResponse::Ok().json(sessions))
}

async fn create(
    req: HttpRequest,
    state: web::Data<AppState>,
    team: web::Path<String>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let actor = authorize(&req, &state, &team, TeamAction::UseSuperAgent).await?;
    let body: CreateRequest = read_body(&req, body).await?;
    let fingerprint = match &body.message {
        Some(message) => {
            message.validate()?;
            message.fingerprint("create", "")
        }
        None => "create".to_owned(),
    };
    let eve = runtime(&state)?;
    let key = request_key(&actor, &team, &body.operation_id)?;
    let admitted = period(&state, &team).await?.admitted;
    let claim = state
        .store
        .claim_cloud_prewarm(&team, &key, &fingerprint, admitted)
        .await?;
    let session = match claim {
        CloudPrewarm::Completed(session) => session,
        CloudPrewarm::Claimed { until } => match prewarm(&state, eve, &key).await {
            Ok(session) => session,
            Err(error) => {
                state.store.release_cloud_prewarm(&key, until).await?;
                return Err(error);
            }
        },
    };
    state.store.bind_cloud_session(&team, &session).await?;
    if let Some(message) = body.message {
        // The creation receipt admitted this payload. Finish it on the bound winner,
        // including when the quota changes between prewarm and delivery or retry.
        let delivery_key = hash(&["initial-message", &key]);
        let delivery = deliver(&state, &team, &session, &delivery_key, &message, true).await?;
        return Ok(
            HttpResponse::Accepted().json(json!({"sessionId":session,"deliveryId":delivery}))
        );
    }
    Ok(HttpResponse::Accepted().json(json!({"sessionId":session})))
}

async fn prewarm(state: &AppState, eve: &EveClient, key: &str) -> Result<String> {
    // A retry after a lost response uses the same upstream create key. If replicas
    // race, only the winning handle is authorized to receive a paid message.
    let response = client::send(
        eve.post(&["eve", "v1", "session"])?
            .json(&json!({"operationId":key})),
    )
    .await?;
    let created: Created = response.json().await.map_err(|_| client::unavailable())?;
    if !client::valid_segment(&created.session_id) {
        return Err(client::unavailable());
    }
    let winner = state
        .store
        .finish_cloud_agent_request(key, &created.session_id)
        .await?;
    if winner != created.session_id {
        let close = eve
            .post(&["eve", "v1", "session", &created.session_id, "end"])?
            .timeout(Duration::from_secs(5));
        if client::send(close).await.is_err() {
            tracing::warn!(session_id = %created.session_id, "could not close unused Super Agent prewarm");
        }
    }
    Ok(winner)
}

async fn message(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<(String, String)>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let (team, session) = path.into_inner();
    let actor = authorize(&req, &state, &team, TeamAction::UseSuperAgent).await?;
    require_session(&state, &team, &session).await?;
    let body: MessageRequest = read_body(&req, body).await?;
    body.message.validate()?;
    let key = request_key(&actor, &team, &body.operation_id)?;
    let admitted = period(&state, &team).await?.admitted;
    let delivery = deliver(&state, &team, &session, &key, &body.message, admitted).await?;
    Ok(HttpResponse::Accepted().json(json!({"sessionId":session,"deliveryId":delivery})))
}

async fn deliver(
    state: &AppState,
    team: &str,
    session: &str,
    key: &str,
    message: &Message,
    admitted: bool,
) -> Result<String> {
    let eve = runtime(state)?;
    let fingerprint = message.fingerprint("message", session);
    let saved = state
        .store
        .cloud_message_request(team, key, &fingerprint, session, admitted)
        .await?;
    let delivery = match saved {
        Some(delivery) => delivery,
        None => {
            // Schedule usage collection before delivery: eve may accept the
            // message even when the HTTP acknowledgement is lost.
            state.store.wake_cloud_meter(team, session).await?;
            let response = client::send(eve.post(&["eve", "v1", "session", session])?.json(
                &EveDelivery {
                    message,
                    idempotency_key: key,
                },
            ))
            .await?;
            let sent: Delivered = response.json().await.map_err(|_| client::unavailable())?;
            if sent.delivery_id.is_empty() {
                return Err(client::unavailable());
            }
            state
                .store
                .finish_cloud_agent_request(key, &sent.delivery_id)
                .await?
        }
    };
    if let Some(title) = message.title() {
        state.store.name_cloud_session(team, session, title).await?;
    }
    Ok(delivery)
}

async fn stream(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<(String, String)>,
    query: web::Query<StreamQuery>,
) -> Result<HttpResponse> {
    let (team, session) = path.into_inner();
    authorize(&req, &state, &team, TeamAction::Read).await?;
    require_session(&state, &team, &session).await?;
    let response = client::send(
        runtime(&state)?
            .get(&["eve", "v1", "session", &session, "stream"])?
            .query(&[
                ("startIndex", query.start_index.to_string()),
                ("follow", "false".to_owned()),
            ])
            .timeout(Duration::from_secs(120)),
    )
    .await?;
    let mut out = HttpResponse::Ok();
    out.content_type("application/x-ndjson");
    for name in ["x-eve-stream-version", "x-eve-stream-tail-index"] {
        if let Some(value) = response.headers().get(name).and_then(|h| h.to_str().ok()) {
            out.insert_header((name, value));
        }
    }
    Ok(out.streaming(futures_util::stream::try_unfold(
        response,
        |mut response| async move {
            Ok::<_, std::io::Error>(
                response
                    .chunk()
                    .await
                    .map_err(|_| std::io::Error::other("Super Agent stream disconnected"))?
                    .map(|chunk| (chunk, response)),
            )
        },
    )))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    runtime_configured: bool,
    #[serde(flatten)]
    period: CloudTokenPeriod,
}

async fn usage(
    req: HttpRequest,
    state: web::Data<AppState>,
    team: web::Path<String>,
) -> Result<HttpResponse> {
    authorize(&req, &state, &team, TeamAction::ReadUsage).await?;
    let runtime_configured = state.eve.is_some();
    let mut period = period(&state, &team).await?;
    period.admitted &= runtime_configured;
    Ok(HttpResponse::Ok().json(Usage {
        runtime_configured,
        period,
    }))
}

#[cfg(test)]
mod tests;
