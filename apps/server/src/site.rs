//! Site configuration handlers; authorization remains in the store operations.
use crate::{AppState, auth, error::Result};
use actix_web::{HttpRequest, web};
use deskfleet_protocol::control::SiteSettings;

pub async fn public_settings(state: web::Data<AppState>) -> Result<web::Json<SiteSettings>> {
    Ok(web::Json(state.store.site_settings().await?))
}

pub async fn admin_settings(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<web::Json<SiteSettings>> {
    let session = auth::user(&req, &state).await?;
    Ok(web::Json(
        state.store.read_site_settings(&session.user.id).await?,
    ))
}

pub async fn update_settings(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<SiteSettings>,
) -> Result<web::Json<SiteSettings>> {
    let session = auth::user(&req, &state).await?;
    Ok(web::Json(
        state
            .store
            .update_site_settings(&session.user.id, &body)
            .await?,
    ))
}
