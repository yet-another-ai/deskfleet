//! Control plane with trusted identity/signaling, PostgreSQL replicas, and optional Web hosting.
mod ai_usage;
mod api;
pub mod auth;
pub mod billing;
pub mod config;
pub mod error;
mod hub;
mod maintenance;
mod peers;
mod site;
mod turn_usage;
mod web_assets;
mod websocket;

pub use web_assets::WebAssets;

use actix_web::{web, web::ServiceConfig};
use config::ServerConfig;
use deskfleet_control_store::ControlStore;
use deskfleet_protocol::{HealthResponse, control::ControlMessage};
use error::Result;

pub struct AppState {
    pub store: ControlStore,
    pub config: ServerConfig,
    pub auth: auth::AuthService,
    pub billing: billing::BillingService,
    hub: hub::Hub,
    _routing: hub::Router,
    _maintenance: maintenance::Maintenance,
    _turn_usage: Option<turn_usage::Collector>,
    _billing_worker: billing::BillingWorker,
}
impl AppState {
    pub async fn new(config: ServerConfig) -> Result<Self> {
        let store = ControlStore::connect(&config.database_url)
            .await?
            .with_hosted_mode(config.billing.hosted);
        let auth = auth::AuthService::new(config.auth.clone())?;
        let billing =
            billing::BillingService::new(config.billing.clone(), config.auth.web_url.clone())?;
        let billing_worker = billing.start_worker(store.clone());
        let turn_usage = config
            .turn_usage_redis_url
            .as_deref()
            .map(|url| turn_usage::Collector::start(store.clone(), url))
            .transpose()
            .map_err(|error| error::ApiError::bad(error.to_string()))?;
        let (hub, routing) = hub::Hub::connect(store.clone()).await?;
        let maintenance = maintenance::Maintenance::start(store.clone());
        Ok(Self {
            store,
            config,
            auth,
            billing,
            hub,
            _routing: routing,
            _maintenance: maintenance,
            _turn_usage: turn_usage,
            _billing_worker: billing_worker,
        })
    }
    async fn notify_team(&self, team: &str, message: ControlMessage) -> Result<()> {
        let users = self.store.team_user_ids(team).await?;
        self.hub.notify_users(&users, message).await
    }
}
pub fn configure(config: &mut ServiceConfig) {
    config.app_data(
        web::JsonConfig::default()
            .limit(64 * 1024 * 1024)
            .error_handler(|_, _| error::ApiError::bad("invalid or oversized JSON body").into()),
    );
    config.app_data(
        web::QueryConfig::default()
            .error_handler(|_, _| error::ApiError::bad("invalid query parameters").into()),
    );
    config.route("/healthz", web::get().to(health));
    config.service(
        web::scope("/api")
            .configure(auth::configure)
            .configure(billing::configure)
            .route("/site", web::get().to(site::public_settings))
            .route("/admin/site-settings", web::get().to(site::admin_settings))
            .route(
                "/admin/site-settings",
                web::patch().to(site::update_settings),
            )
            .route("/teams", web::get().to(api::teams))
            .route("/teams", web::post().to(api::create_team))
            .route("/teams/{teamId}", web::patch().to(api::rename_team))
            .route("/teams/{teamId}", web::delete().to(api::delete_team))
            .route("/teams/{teamId}/usage", web::get().to(api::team_usage))
            .route("/teams/{teamId}/ai-usage", web::get().to(ai_usage::summary))
            .route(
                "/teams/{teamId}/ai-usage/sessions",
                web::get().to(ai_usage::sessions),
            )
            .route("/teams/{teamId}/members", web::get().to(api::members))
            .route(
                "/teams/{teamId}/members/{userId}",
                web::patch().to(api::change_member),
            )
            .route(
                "/teams/{teamId}/members/{userId}",
                web::delete().to(api::remove_member),
            )
            .route("/teams/{teamId}/invites", web::post().to(api::invite))
            .route("/invites/accept", web::post().to(api::accept_invite))
            .route("/teams/{teamId}/machines", web::get().to(api::machines))
            .route("/teams/{teamId}/machines", web::post().to(api::enroll))
            .route(
                "/machines/{machineId}",
                web::patch().to(api::rename_machine),
            )
            .route(
                "/machines/{machineId}",
                web::delete().to(api::remove_machine),
            )
            .route("/machines/{machineId}/rpc", web::post().to(api::rpc))
            .route("/machines/{machineId}/catalog", web::get().to(api::catalog))
            .route(
                "/machines/{machineId}/sessions",
                web::get().to(api::sessions),
            )
            .route(
                "/machines/{machineId}/sessions/{sessionId}",
                web::get().to(api::snapshot),
            )
            .route(
                "/machines/{machineId}/sessions/{sessionId}/events",
                web::get().to(api::events),
            )
            .route(
                "/machines/{machineId}/sessions/{sessionId}/commands",
                web::get().to(api::commands),
            )
            .route(
                "/machines/{machineId}/commands/{operationId}",
                web::get().to(api::command),
            )
            .route("/daemon/me", web::get().to(api::daemon_me))
            .route(
                "/daemon/authorize-delegation",
                web::post().to(api::authorize_delegation),
            )
            .route("/daemon/catalog", web::post().to(api::sync_catalog))
            .route("/daemon/history", web::post().to(api::sync_history))
            .route("/daemon/ws", web::get().to(websocket::daemon))
            .route("/client/ws", web::get().to(websocket::client))
            .route("/peers", web::post().to(peers::create))
            .route("/peers/local", web::post().to(peers::create_local))
            .route("/peers/{peerId}", web::delete().to(peers::close))
            .route("/peers/{peerId}/offer", web::post().to(peers::offer))
            .route(
                "/peers/{peerId}/candidate",
                web::post().to(peers::candidate),
            )
            .route("/peers/{peerId}/start", web::post().to(peers::start)),
    );
}
async fn health() -> web::Json<HealthResponse> {
    web::Json(HealthResponse::ok(env!("CARGO_PKG_VERSION")))
}

#[cfg(test)]
mod integration_tests;

#[cfg(test)]
mod realtime_tests;
