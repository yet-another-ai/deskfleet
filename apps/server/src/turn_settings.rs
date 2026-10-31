//! Private, runtime TURN URL configuration for site administrators.
use crate::{
    AppState, auth,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, web};
use deskfleet_protocol::control::TurnSettings;

pub async fn initialize(
    store: &deskfleet_control_store::ControlStore,
    config: &crate::config::ServerConfig,
) -> Result<()> {
    let settings = match store.turn_settings().await {
        Ok(settings) => settings,
        Err(deskfleet_control_store::Error::NotFound) => {
            require_secret(&config.turn_urls, config.turn_secret.as_deref())?;
            store.seed_turn_settings(&config.turn_urls).await?;
            store.turn_settings().await?
        }
        Err(error) => return Err(error.into()),
    };
    require_secret(&settings.urls, config.turn_secret.as_deref())
}

fn require_secret(urls: &[String], secret: Option<&str>) -> Result<()> {
    if !urls.is_empty() && secret.is_none_or(str::is_empty) {
        return Err(ApiError::bad(
            "Configure DESKFLEET_TURN_SECRET before adding TURN servers",
        ));
    }
    Ok(())
}

pub async fn read(req: HttpRequest, state: web::Data<AppState>) -> Result<web::Json<TurnSettings>> {
    let session = auth::user(&req, &state).await?;
    Ok(web::Json(
        state.store.read_turn_settings(&session.user.id).await?,
    ))
}

pub async fn update(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<TurnSettings>,
) -> Result<web::Json<TurnSettings>> {
    let session = auth::user(&req, &state).await?;
    state.store.read_turn_settings(&session.user.id).await?;
    require_secret(&body.urls, state.config.turn_secret.as_deref())?;
    Ok(web::Json(
        state
            .store
            .update_turn_settings(&session.user.id, &body)
            .await?,
    ))
}
