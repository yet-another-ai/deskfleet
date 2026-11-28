use super::{
    AppState, HttpRequest, HttpResponse, Result, TeamAction, authorize, client::SessionControl,
    runtime, validate_session_id, web,
};
use deskfleet_control_store::CloudSessionGuard;

type SessionPath = web::Path<(String, String)>;

async fn lock(
    req: &HttpRequest,
    state: &AppState,
    path: &SessionPath,
) -> Result<CloudSessionGuard> {
    authorize(req, state, &path.0, TeamAction::UseSuperAgent).await?;
    validate_session_id(&path.1)?;
    Ok(state.store.lock_cloud_session(&path.0, &path.1).await?)
}

pub(super) async fn archive(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: SessionPath,
) -> Result<HttpResponse> {
    let guard = lock(&req, &state, &path).await?;
    if !guard.archived {
        // A guardless Eve cancel also stops background tasks between turns.
        runtime(&state)?
            .stop_session(&path.1, SessionControl::Cancel)
            .await?;
    }
    guard.set_archived(true).await?;
    Ok(HttpResponse::NoContent().finish())
}

pub(super) async fn restore(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: SessionPath,
) -> Result<HttpResponse> {
    lock(&req, &state, &path).await?.set_archived(false).await?;
    Ok(HttpResponse::NoContent().finish())
}

pub(super) async fn delete(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: SessionPath,
) -> Result<HttpResponse> {
    let guard = lock(&req, &state, &path).await?;
    runtime(&state)?
        .stop_session(&path.1, SessionControl::End)
        .await?;
    guard.delete().await?;
    Ok(HttpResponse::NoContent().finish())
}
