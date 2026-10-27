//! Deployment-owned origins, WebAuthn RP and mail transport. No provider identity.
use std::{env, io, net::IpAddr, path::PathBuf};

#[derive(Clone)]
pub enum MailConfig {
    Local {
        directory: PathBuf,
    },
    Smtp {
        host: String,
        port: u16,
        username: String,
        password: String,
        from: String,
    },
}
#[derive(Clone)]
pub struct AuthConfig {
    pub web_url: String,
    pub allowed_origins: Vec<String>,
    pub return_to: Vec<String>,
    pub rp_id: String,
    pub secure_cookies: bool,
    pub trusted_proxy_ips: Vec<IpAddr>,
    pub mail: MailConfig,
}
impl AuthConfig {
    pub fn development(public_url: &str) -> Self {
        let mut origin = url::Url::parse(public_url).ok();
        if let Some(url) = &mut origin
            && matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))
        {
            let _ = url.set_host(Some("localhost"));
        }
        let web_url = origin
            .as_ref()
            .map(|url| url.origin().ascii_serialization())
            .unwrap_or_else(|| public_url.to_owned());
        Self {
            web_url: web_url.clone(),
            allowed_origins: vec![public_url.trim_end_matches('/').into(), web_url],
            return_to: vec!["http://127.0.0.1:*/auth/callback".into()],
            rp_id: origin
                .as_ref()
                .and_then(|u| u.host_str())
                .unwrap_or("localhost")
                .into(),
            secure_cookies: origin.is_some_and(|u| u.scheme() == "https"),
            trusted_proxy_ips: vec![],
            mail: MailConfig::Local {
                directory: std::env::temp_dir().join("deskfleet-mails"),
            },
        }
    }
    pub fn from_env(public_url: &str, web_origins: &[String]) -> io::Result<Self> {
        let web_url = env::var("DESKFLEET_AUTH_WEB_URL").unwrap_or_else(|_| {
            web_origins
                .first()
                .cloned()
                .unwrap_or_else(|| public_url.into())
        });
        let parsed =
            url::Url::parse(&web_url).map_err(|_| invalid("invalid DESKFLEET_AUTH_WEB_URL"))?;
        let public = url::Url::parse(public_url).map_err(|_| invalid("invalid public URL"))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(invalid("authentication Web URL must be an origin"));
        }
        if parsed.domain().is_none() {
            return Err(invalid(
                "WebAuthn requires a DNS hostname; use localhost for local development",
            ));
        }
        let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if parsed.scheme() != "https" && !local {
            return Err(invalid("authentication requires HTTPS outside localhost"));
        }
        let public_local = matches!(public.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if public.scheme() != "https" && !(public.scheme() == "http" && public_local) {
            return Err(invalid("public API URL requires HTTPS outside localhost"));
        }
        let mail = if let Ok(host) = env::var("DESKFLEET_SMTP_HOST") {
            MailConfig::Smtp {
                host,
                port: env::var("DESKFLEET_SMTP_PORT")
                    .unwrap_or_else(|_| "587".into())
                    .parse()
                    .map_err(|_| invalid("invalid SMTP port"))?,
                username: required("DESKFLEET_SMTP_USERNAME")?,
                password: required("DESKFLEET_SMTP_PASSWORD")?,
                from: required("DESKFLEET_MAIL_FROM")?,
            }
        } else if local {
            MailConfig::Local {
                directory: env::var_os("DESKFLEET_MAIL_DIRECTORY")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from(".local/mail")),
            }
        } else {
            return Err(invalid(
                "SMTP configuration is required outside local development",
            ));
        };
        let mut allowed_origins = web_origins.to_vec();
        allowed_origins.push(parsed.origin().ascii_serialization());
        allowed_origins.push(public.origin().ascii_serialization());
        allowed_origins.sort();
        allowed_origins.dedup();
        Ok(Self {
            web_url: web_url.trim_end_matches('/').into(),
            allowed_origins,
            return_to: vec!["http://127.0.0.1:*/auth/callback".into()],
            rp_id: env::var("DESKFLEET_WEBAUTHN_RP_ID")
                .unwrap_or_else(|_| parsed.host_str().unwrap_or("localhost").into()),
            secure_cookies: public.scheme() == "https",
            trusted_proxy_ips: env::var("DESKFLEET_TRUSTED_PROXY_IPS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| {
                    value
                        .parse()
                        .map_err(|_| invalid("invalid trusted proxy IP"))
                })
                .collect::<io::Result<Vec<IpAddr>>>()?,
            mail,
        })
    }
}
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
fn required(key: &str) -> io::Result<String> {
    env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| invalid(&format!("{key} is required")))
}
