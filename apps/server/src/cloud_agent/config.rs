//! Team Super Agent configuration (hosted cloud vs registered BYOA machine agent)
//! and BYOA machine-session registration endpoints.
use super::{AppState, HttpRequest, HttpResponse, Result, TeamAction, authorize, read_body, web};
use deskfleet_control_store::{
    Error as StoreError, RegisterSuperAgentMachineSession, SuperAgentByoaTarget, SuperAgentMode,
    TeamSuperAgentConfig, TeamSuperAgentConfigUpdate,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ByoaTargetResponse {
    machine_id: String,
    machine_name: String,
    machine_online: bool,
    provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigResponse {
    mode: SuperAgentMode,
    hosted_configured: bool,
    can_configure: bool,
    byoa: Option<ByoaTargetResponse>,
}

async fn enrich(
    state: &AppState,
    config: TeamSuperAgentConfig,
    can_configure: bool,
) -> ConfigResponse {
    let byoa = match config.byoa {
        Some(SuperAgentByoaTarget {
            registration_id,
            machine_id,
            machine_name,
            provider_id,
            provider_name,
            workspace_id,
            workspace_name,
            cwd,
        }) => {
            let online = state.hub.online_machines(&[registration_id.clone()]).await;
            Some(ByoaTargetResponse {
                machine_id,
                machine_name,
                machine_online: online.contains(&registration_id),
                provider_id,
                provider_name,
                workspace_id,
                workspace_name,
                cwd,
            })
        }
        None => None,
    };
    ConfigResponse {
        mode: config.mode,
        hosted_configured: state.eve.is_some(),
        can_configure,
        byoa,
    }
}

pub(super) async fn get_config(
    req: HttpRequest,
    state: web::Data<AppState>,
    team: web::Path<String>,
) -> Result<HttpResponse> {
    let actor = authorize(&req, &state, &team, TeamAction::Read).await?;
    let can_configure = match state
        .store
        .authorize_team(&actor.user.id, &team, TeamAction::ManageSuperAgent)
        .await
    {
        Ok(()) => true,
        Err(StoreError::Forbidden) => false,
        Err(error) => return Err(error.into()),
    };
    let config = state.store.team_super_agent_config(&team).await?;
    Ok(HttpResponse::Ok().json(enrich(&state, config, can_configure).await))
}

pub(super) async fn update_config(
    req: HttpRequest,
    state: web::Data<AppState>,
    team: web::Path<String>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let actor = authorize(&req, &state, &team, TeamAction::ManageSuperAgent).await?;
    let body: TeamSuperAgentConfigUpdate = read_body(&req, body).await?;
    let config = state
        .store
        .update_team_super_agent_config(&actor.user.id, &team, &body)
        .await?;
    Ok(HttpResponse::Ok().json(enrich(&state, config, true).await))
}

pub(super) async fn register_machine_session(
    req: HttpRequest,
    state: web::Data<AppState>,
    team: web::Path<String>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let actor = authorize(&req, &state, &team, TeamAction::UseSuperAgent).await?;
    let body: RegisterSuperAgentMachineSession = read_body(&req, body).await?;
    let session = state
        .store
        .register_super_agent_machine_session(&actor.user.id, &team, &body)
        .await?;
    Ok(HttpResponse::Ok().json(session))
}
