//! Authenticated Team gateway to the private Super Agent runtime.
mod client;
mod rollout;

use crate::{
    AppState, auth,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, middleware::DefaultHeaders, web};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
pub(crate) use client::EveClient;
use deskfleet_control_store::{billing::CloudTokenPeriod, policies::TeamAction};
pub(crate) use rollout::Rollout;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::time::Duration;

pub(crate) fn configure(config: &mut web::ServiceConfig) {
    config.service(
        web::scope("/teams/{teamId}/super-agent")
            .wrap(DefaultHeaders::new().add(("Cache-Control", "no-store")))
            .app_data(
                web::JsonConfig::default()
                    .limit(256 * 1024)
                    .error_handler(|_, _| {
                        ApiError::bad("invalid or oversized Super Agent request").into()
                    }),
            )
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MessageRequest {
    operation_id: String,
    message: String,
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
    body: web::Json<CreateRequest>,
) -> Result<HttpResponse> {
    let actor = authorize(&req, &state, &team, TeamAction::UseSuperAgent).await?;
    let eve = runtime(&state)?;
    let key = request_key(&actor, &team, &body.operation_id)?;
    let admitted = period(&state, &team).await?.admitted;
    let saved = state
        .store
        .cloud_agent_request(&team, &key, "create", None, admitted)
        .await?;
    let session = match saved {
        Some(session) => session,
        None => {
            // A prewarm is empty. If replicas race, only the winning handle is
            // returned and authorized to receive a paid message.
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
                .finish_cloud_agent_request(&key, &created.session_id)
                .await?;
            if winner != created.session_id {
                let close = eve
                    .post(&["eve", "v1", "session", &created.session_id, "end"])?
                    .timeout(Duration::from_secs(5));
                if client::send(close).await.is_err() {
                    tracing::warn!(session_id = %created.session_id, "could not close unused Super Agent prewarm");
                }
            }
            winner
        }
    };
    state.store.bind_cloud_session(&team, &session).await?;
    Ok(HttpResponse::Accepted().json(json!({"sessionId":session})))
}

async fn message(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<(String, String)>,
    body: web::Json<MessageRequest>,
) -> Result<HttpResponse> {
    let (team, session) = path.into_inner();
    let actor = authorize(&req, &state, &team, TeamAction::UseSuperAgent).await?;
    require_session(&state, &team, &session).await?;
    let eve = runtime(&state)?;
    if body.message.trim().is_empty() {
        return Err(ApiError::bad("message must contain text"));
    }
    let key = request_key(&actor, &team, &body.operation_id)?;
    let fingerprint = hash(&["message", &session, &body.message]);
    let admitted = period(&state, &team).await?.admitted;
    let saved = state
        .store
        .cloud_agent_request(&team, &key, &fingerprint, Some(&session), admitted)
        .await?;
    let delivery = match saved {
        Some(delivery) => delivery,
        None => {
            // Schedule usage collection before delivery: eve may accept the
            // message even when the HTTP acknowledgement is lost.
            state.store.wake_cloud_meter(&team, &session).await?;
            let response = client::send(
                eve.post(&["eve", "v1", "session", &session])?
                    .json(&json!({"message": body.message, "idempotencyKey": key})),
            )
            .await?;
            let sent: Delivered = response.json().await.map_err(|_| client::unavailable())?;
            if sent.delivery_id.is_empty() {
                return Err(client::unavailable());
            }
            state
                .store
                .finish_cloud_agent_request(&key, &sent.delivery_id)
                .await?
        }
    };
    state
        .store
        .name_cloud_session(&team, &session, &body.message)
        .await?;
    Ok(HttpResponse::Accepted().json(json!({"sessionId":session,"deliveryId":delivery})))
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
