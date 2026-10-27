//! Startup configuration for an API-only central service.
use std::{env, io, net::SocketAddr};

#[derive(Clone)]
pub struct ServerConfig {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub public_url: String,
    pub web_origins: Vec<String>,
    pub auth: crate::auth::config::AuthConfig,
    pub billing: crate::billing::BillingConfig,
    /// Operator-configured STUN URLs advertised on peer grants. Empty means none.
    pub stun_urls: Vec<String>,
    /// Operator-configured TURN/TURNS URLs advertised on peer grants. Empty means none.
    pub turn_urls: Vec<String>,
    pub turn_secret: Option<String>,
    pub turn_usage_redis_url: Option<String>,
}
impl ServerConfig {
    pub fn from_env() -> io::Result<Self> {
        let public_url =
            env::var("DESKFLEET_PUBLIC_URL").unwrap_or_else(|_| "http://localhost:8080".into());
        let web_origins = list("DESKFLEET_WEB_ORIGINS");
        let auth = crate::auth::config::AuthConfig::from_env(&public_url, &web_origins)?;
        let billing = crate::billing::BillingConfig::from_env()?;
        let stun_urls = ice_urls("DESKFLEET_STUN_URLS", &["stun", "stuns"])?;
        let turn_urls = ice_urls("DESKFLEET_TURN_URLS", &["turn", "turns"])?;
        let turn_secret = env::var("DESKFLEET_TURN_SECRET")
            .ok()
            .filter(|value| !value.is_empty());
        if !turn_urls.is_empty() && turn_secret.is_none() {
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
            web_origins,
            auth,
            billing,
            stun_urls,
            turn_urls,
            turn_secret,
            turn_usage_redis_url: env::var("DESKFLEET_TURN_USAGE_REDIS_URL")
                .ok()
                .filter(|value| !value.is_empty()),
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
    parse_list(&env::var(key).unwrap_or_default())
}
fn ice_urls(key: &str, schemes: &[&str]) -> io::Result<Vec<String>> {
    parse_ice_urls(key, &env::var(key).unwrap_or_default(), schemes)
}
fn parse_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn parse_ice_urls(key: &str, value: &str, schemes: &[&str]) -> io::Result<Vec<String>> {
    let urls = parse_list(value);
    for url in &urls {
        if !has_ice_scheme(url, schemes) {
            let allowed = schemes.join("/");
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{key} entries must use {allowed}: URLs"),
            ));
        }
    }
    Ok(urls)
}
fn has_ice_scheme(url: &str, schemes: &[&str]) -> bool {
    schemes.iter().any(|scheme| {
        let prefix = format!("{scheme}:");
        url.len() > prefix.len() && url[..prefix.len()].eq_ignore_ascii_case(&prefix)
    })
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
    use super::{has_ice_scheme, parse_bind_addr, parse_ice_urls, parse_list};
    #[test]
    fn listener_requires_ip_and_port() {
        for value in ["", "127.0.0.1", "localhost:80", "127.0.0.1:65536"] {
            assert!(parse_bind_addr(value).is_err())
        }
    }
    #[test]
    fn ice_url_lists_trim_and_skip_empty_entries() {
        assert_eq!(
            parse_list(" stun:a:1 , ,stun:b:2 "),
            vec!["stun:a:1".to_owned(), "stun:b:2".to_owned()]
        );
        assert!(parse_list("").is_empty());
        assert!(parse_list(" , , ").is_empty());
    }
    #[test]
    fn stun_and_turn_lists_require_matching_schemes() {
        assert_eq!(
            parse_ice_urls(
                "DESKFLEET_STUN_URLS",
                "stun:turn.example.com:3478,stuns:turn.example.com:5349",
                &["stun", "stuns"]
            )
            .unwrap(),
            vec![
                "stun:turn.example.com:3478".to_owned(),
                "stuns:turn.example.com:5349".to_owned()
            ]
        );
        assert_eq!(
            parse_ice_urls(
                "DESKFLEET_TURN_URLS",
                "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp",
                &["turn", "turns"]
            )
            .unwrap(),
            vec![
                "turn:turn.example.com:3478?transport=udp".to_owned(),
                "turns:turn.example.com:5349?transport=tcp".to_owned()
            ]
        );
        assert!(
            parse_ice_urls(
                "DESKFLEET_STUN_URLS",
                "turn:turn.example.com:3478",
                &["stun", "stuns"]
            )
            .is_err()
        );
        assert!(
            parse_ice_urls(
                "DESKFLEET_TURN_URLS",
                "stun:turn.example.com:3478",
                &["turn", "turns"]
            )
            .is_err()
        );
        assert!(parse_ice_urls("DESKFLEET_STUN_URLS", "stun:", &["stun", "stuns"]).is_err());
        assert!(has_ice_scheme("STUN:example.com:3478", &["stun", "stuns"]));
    }
}
