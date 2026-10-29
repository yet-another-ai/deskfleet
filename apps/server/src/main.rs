use actix_web::{App, HttpServer, web};
use deskfleet_server::{AppState, WebAssets, config::ServerConfig, configure};
use tracing_subscriber::EnvFilter;

mod cli;
mod listeners;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .try_init()
        .map_err(std::io::Error::other)?;
    if cli::run(&std::env::args().skip(1).collect::<Vec<_>>()).await? {
        return Ok(());
    }
    let config = ServerConfig::from_env()?;
    let web_assets = WebAssets::from_env()?;
    let listeners = listeners::bind_all(&config.bind_addrs)?;
    let origins = config.web_origins.clone();
    let state = web::Data::new(AppState::new(config).await.map_err(std::io::Error::other)?);
    let mut server = HttpServer::new(move || {
        let mut cors = actix_cors::Cors::default()
            .allowed_methods(["GET", "POST", "PUT", "PATCH", "DELETE"])
            .allowed_headers(["authorization", "content-type", "x-csrf-token"])
            .supports_credentials()
            .max_age(3600);
        for origin in &origins {
            cors = cors.allowed_origin(origin);
        }
        App::new()
            .wrap(cors)
            .app_data(state.clone())
            .configure(configure)
            .configure(|config| {
                if let Some(assets) = &web_assets {
                    assets.configure(config);
                }
            })
    });
    for listener in listeners {
        server = server.listen(listener)?;
    }
    for address in server.addrs() {
        tracing::info!(%address,"DeskFleet server listening");
    }
    server.run().await
}
