//! Deployment-owned network endpoints for local client diagnostics.

use actix_web::{HttpRequest, web};
use deskfleet_protocol::control::NetworkConfiguration;

use crate::{AppState, auth, error::Result};

pub async fn read(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<web::Json<NetworkConfiguration>> {
    auth::user(&req, &state).await?;
    Ok(web::Json(NetworkConfiguration {
        stun_urls: state.config.stun_urls.clone(),
    }))
}
