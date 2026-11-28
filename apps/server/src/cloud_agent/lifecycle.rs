use super::{
    AppState, HttpRequest, HttpResponse, Result, TeamAction, authorize, client::SessionControl,
    runtime, validate_session_id, web,
};

type SessionPath = web::Path<(String, String)>;

async fn authorize_session(req: &HttpRequest, state: &AppState, path: &SessionPath) -> Result<()> {
    authorize(req, state, &path.0, TeamAction::UseSuperAgent).await?;
    validate_session_id(&path.1)
}

pub(super) async fn archive(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: SessionPath,
) -> Result<HttpResponse> {
    authorize_session(&req, &state, &path).await?;
    let guard = state.store.lock_cloud_session(&path.0, &path.1).await?;
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
    authorize_session(&req, &state, &path).await?;
    let guard = state.store.lock_cloud_session(&path.0, &path.1).await?;
    guard.set_archived(false).await?;
    Ok(HttpResponse::NoContent().finish())
}

pub(super) async fn delete(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: SessionPath,
) -> Result<HttpResponse> {
    authorize_session(&req, &state, &path).await?;
    if let Some(guard) = state
        .store
        .lock_cloud_session_for_delete(&path.0, &path.1)
        .await?
    {
        runtime(&state)?
            .stop_session(&path.1, SessionControl::End)
            .await?;
        guard.delete().await?;
    }
    Ok(HttpResponse::NoContent().finish())
}
