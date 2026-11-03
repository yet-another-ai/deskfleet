//! Runtime Cloudflare TURN configuration, credentials and independent metering.
mod client;
mod collector;

use crate::{AppState, auth, error::Result};
use actix_web::{HttpRequest, web};
use deskfleet_control_store::{ControlStore, now_ms};
use deskfleet_protocol::control::{
    CloudflareTurnSettings, CloudflareTurnSettingsUpdate, IceServer,
};

pub(crate) struct Service {
    client: client::Client,
    _collector: collector::Collector,
}

impl Service {
    pub(crate) fn new(store: ControlStore) -> Result<Self> {
        let client = client::Client::new()?;
        Ok(Self::with_client(store, client))
    }

    fn with_client(store: ControlStore, client: client::Client) -> Self {
        Self {
            _collector: collector::Collector::start(store, client.clone()),
            client,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_endpoints(store: ControlStore, origin: &str) -> Self {
        let mut client = client::Client::new().unwrap();
        client.credentials_url = format!("{origin}/keys");
        client.analytics_url = format!("{origin}/graphql");
        Self::with_client(store, client)
    }

    pub(crate) async fn ice_servers(
        &self,
        store: &ControlStore,
        team_id: &str,
        expires_at: i64,
    ) -> Result<Vec<IceServer>> {
        let config = store.cloudflare_turn_config().await?;
        if !config.enabled {
            return Ok(Vec::new());
        }
        let identifier = store
            .prepare_cloudflare_turn_usage(team_id, &config, expires_at)
            .await?;
        let ttl = ((expires_at - now_ms()) / 1_000).clamp(1, 172_800);
        self.client
            .generate(&config.key_id, &config.api_token, &identifier, ttl)
            .await
    }
}

pub(crate) async fn read(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<web::Json<CloudflareTurnSettings>> {
    let session = auth::user(&req, &state).await?;
    Ok(web::Json(
        state
            .store
            .read_cloudflare_turn_settings(&session.user.id)
            .await?,
    ))
}

pub(crate) async fn update(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<CloudflareTurnSettingsUpdate>,
) -> Result<web::Json<CloudflareTurnSettings>> {
    let session = auth::user(&req, &state).await?;
    Ok(web::Json(
        state
            .store
            .update_cloudflare_turn_settings(&session.user.id, &body)
            .await?,
    ))
}
