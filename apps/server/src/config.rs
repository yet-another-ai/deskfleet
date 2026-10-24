//! Startup configuration for an API-only central service.
use std::{env, io, net::SocketAddr};

#[derive(Clone)]
pub struct OidcConfig {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub callback_url: String,
    pub return_to: Vec<String>,
}
#[derive(Clone)]
pub struct ServerConfig {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub public_url: String,
    pub web_origins: Vec<String>,
    pub oidc: Option<OidcConfig>,
    pub stun_urls: Vec<String>,
    pub turn_urls: Vec<String>,
    pub turn_secret: Option<String>,
}
impl ServerConfig {
    pub fn from_env() -> io::Result<Self> {
        let public_url =
            env::var("DESKFLEET_PUBLIC_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
        let oidc = match env::var("DESKFLEET_OIDC_ISSUER") {
            Ok(issuer) => Some(OidcConfig {
                issuer,
                client_id: required("DESKFLEET_OIDC_CLIENT_ID")?,
                client_secret: env::var("DESKFLEET_OIDC_CLIENT_SECRET").ok(),
                callback_url: format!("{}/api/auth/callback", public_url.trim_end_matches('/')),
                return_to: list("DESKFLEET_OIDC_RETURN_TO"),
            }),
            Err(env::VarError::NotPresent) => None,
            Err(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid OIDC issuer",
                ));
            }
        };
        let turn_urls = list("DESKFLEET_TURN_URLS");
        let turn_secret = env::var("DESKFLEET_TURN_SECRET").ok();
        if !turn_urls.is_empty() && turn_secret.as_deref().is_none_or(str::is_empty) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "DESKFLEET_TURN_SECRET is required with TURN URLs",
            ));
        }
        Ok(Self {
            bind_addr: parse_bind_addr(
                &env::var("DESKFLEET_BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into()),
            )?,
            database_url: required("DATABASE_URL")?,
            public_url,
            web_origins: list("DESKFLEET_WEB_ORIGINS"),
            oidc,
            stun_urls: list("DESKFLEET_STUN_URLS"),
            turn_urls,
            turn_secret,
        })
    }
}
fn required(key: &str) -> io::Result<String> {
    env::var(key)
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("{key} is required")))
}
fn list(key: &str) -> Vec<String> {
    env::var(key)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn parse_bind_addr(value: &str) -> io::Result<SocketAddr> {
    value.parse().map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid DESKFLEET_BIND_ADDR: {e}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::parse_bind_addr;
    #[test]
    fn listener_requires_ip_and_port() {
        for value in ["", "127.0.0.1", "localhost:80", "127.0.0.1:65536"] {
            assert!(parse_bind_addr(value).is_err())
        }
    }
}
