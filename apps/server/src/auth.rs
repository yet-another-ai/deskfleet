//! DeskFleet-owned identity. Browsers use HttpOnly sessions; native clients keep
//! one-use browser exchange credentials in their secure main-process store.
mod account;
pub mod config;
mod desktop;
mod mail;
mod passkeys;
mod passwords;

use crate::{
    AppState,
    error::{ApiError, Result},
};
use actix_web::{
    HttpRequest, HttpResponse,
    cookie::{Cookie, SameSite, time::Duration},
    http::StatusCode,
    web,
};
use deskfleet_control_store::{AuthSession, MachineAuth, secret};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Semaphore;
use webauthn_rs::prelude::*;

const SESSION_COOKIE: &str = "deskfleet_session";
const CSRF_COOKIE: &str = "deskfleet_csrf";
pub struct AuthService {
    pub config: config::AuthConfig,
    webauthn: Webauthn,
    mail: mail::Mailer,
    hashing: Arc<Semaphore>,
}
impl AuthService {
    pub fn new(config: config::AuthConfig) -> Result<Self> {
        let origin = Url::parse(&config.web_url)
            .map_err(|_| ApiError::bad("invalid authentication Web URL"))?;
        let webauthn = WebauthnBuilder::new(&config.rp_id, &origin)
            .map_err(|_| ApiError::bad("invalid WebAuthn RP/origin"))?
            .rp_name("DeskFleet")
            .build()
            .map_err(|_| ApiError::bad("invalid WebAuthn configuration"))?;
        let mail = mail::Mailer::new(config.mail.clone())?;
        Ok(Self {
            config,
            webauthn,
            mail,
            hashing: Arc::new(Semaphore::new(4)),
        })
    }
}
pub fn configure(config: &mut web::ServiceConfig) {
    config
        .route("/auth/config", web::get().to(public_config))
        .route("/auth/register", web::post().to(passwords::register))
        .route("/auth/verify", web::post().to(passwords::verify))
        .route("/auth/login", web::post().to(passwords::login))
        .route("/auth/recovery", web::post().to(passwords::recovery))
        .route(
            "/auth/recovery/complete",
            web::post().to(passwords::recover),
        )
        .route(
            "/auth/reauthenticate",
            web::post().to(passwords::reauthenticate),
        )
        .route("/auth/password", web::post().to(account::password))
        .route("/auth/email", web::post().to(account::email))
        .route("/auth/email/verify", web::post().to(account::verify_email))
        .route("/auth/sessions", web::get().to(account::sessions))
        .route(
            "/auth/sessions/revoke-all",
            web::post().to(account::revoke_all),
        )
        .route(
            "/auth/sessions/{id}",
            web::delete().to(account::revoke_session),
        )
        .route("/auth/registration", web::patch().to(account::registration))
        .route(
            "/admin/users/{id}/disabled",
            web::patch().to(account::disabled),
        )
        .route("/admin/users", web::get().to(account::users))
        .route("/auth/passkeys", web::get().to(passkeys::list))
        .route(
            "/auth/passkeys/register/options",
            web::post().to(passkeys::registration_options),
        )
        .route(
            "/auth/passkeys/register",
            web::post().to(passkeys::register),
        )
        .route("/auth/passkeys/{id}", web::patch().to(passkeys::rename))
        .route("/auth/passkeys/{id}", web::delete().to(passkeys::remove))
        .route(
            "/auth/passkeys/login/options",
            web::post().to(passkeys::login_options),
        )
        .route("/auth/passkeys/login", web::post().to(passkeys::login))
        .route(
            "/auth/passkeys/reauthenticate/options",
            web::post().to(passkeys::reauthentication_options),
        )
        .route(
            "/auth/passkeys/reauthenticate",
            web::post().to(passkeys::reauthenticate),
        )
        .route("/auth/start", web::post().to(desktop::start))
        .route("/auth/desktop/complete", web::post().to(desktop::complete))
        .route("/auth/exchange", web::post().to(desktop::exchange))
        .route("/auth/logout", web::post().to(logout))
        .route("/me", web::get().to(me));
}
pub async fn user(req: &HttpRequest, state: &AppState) -> Result<AuthSession> {
    if let Ok(token) = bearer(req) {
        return Ok(state.store.authenticate(token).await?);
    }
    if !matches!(req.method().as_str(), "GET" | "HEAD" | "OPTIONS") {
        browser_mutation(req, state)?;
    }
    let token = req
        .cookie(SESSION_COOKIE)
        .ok_or_else(ApiError::unauthorized)?;
    Ok(state.store.authenticate(token.value()).await?)
}
pub async fn machine(req: &HttpRequest, state: &AppState) -> Result<MachineAuth> {
    Ok(state.store.authenticate_machine(bearer(req)?).await?)
}
fn bearer(req: &HttpRequest) -> Result<&str> {
    req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| !s.is_empty() && s.len() < 512)
        .ok_or_else(ApiError::unauthorized)
}
pub(crate) fn browser_origin(req: &HttpRequest, state: &AppState) -> Result<()> {
    let origin = req
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(ApiError::forbidden)?;
    if !state
        .auth
        .config
        .allowed_origins
        .iter()
        .any(|allowed| allowed == origin)
    {
        return Err(ApiError::forbidden());
    }
    Ok(())
}
fn browser_mutation(req: &HttpRequest, state: &AppState) -> Result<()> {
    browser_origin(req, state)?;
    let cookie = req.cookie(CSRF_COOKIE).ok_or_else(ApiError::forbidden)?;
    let header = req
        .headers()
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(ApiError::forbidden)?;
    if cookie.value().len() < 32 || cookie.value() != header {
        return Err(ApiError::forbidden());
    }
    Ok(())
}
pub(crate) fn cookie_token(req: &HttpRequest) -> Option<String> {
    req.cookie(SESSION_COOKIE).map(|c| c.value().to_owned())
}
pub(crate) async fn recent(req: &HttpRequest, state: &AppState) -> Result<AuthSession> {
    let auth = user(req, state).await?;
    if !state.store.recent_authentication(&auth.id).await? {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "recent_authentication_required",
            "Confirm your password or Passkey to continue.",
        ));
    }
    Ok(auth)
}
// Only explicitly configured proxies may supply a client IP. They must overwrite
// X-Real-IP; arbitrary forwarded headers from Internet clients are ignored.
fn client_ip(req: &HttpRequest, config: &config::AuthConfig) -> Option<std::net::IpAddr> {
    let peer = req.peer_addr()?.ip();
    if config.trusted_proxy_ips.contains(&peer)
        && let Some(forwarded) = req
            .headers()
            .get("x-real-ip")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
    {
        return Some(forwarded);
    }
    Some(peer)
}
async fn limit(req: &HttpRequest, state: &AppState, kind: &str, email: Option<&str>) -> Result<()> {
    let ip = client_ip(req, &state.auth.config)
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| "unknown".into());
    let allowed = state
        .store
        .auth_rate_limit(&format!("{kind}:ip:{ip}"), 30, 60_000)
        .await?;
    let address_allowed = if let Some(email) = email {
        state
            .store
            .auth_rate_limit(&format!("{kind}:email:{email}"), 5, 60_000)
            .await?
    } else {
        true
    };
    if !allowed || !address_allowed {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many attempts. Try again later.",
        ));
    }
    Ok(())
}
fn cookie(name: &str, value: String, state: &AppState, http_only: bool) -> Cookie<'static> {
    Cookie::build(name.to_owned(), value)
        .path("/")
        .secure(state.auth.config.secure_cookies)
        .http_only(http_only)
        .same_site(SameSite::Lax)
        .max_age(Duration::days(30))
        .finish()
}
fn session_response(state: &AppState, mut session: Value) -> Result<HttpResponse> {
    let token = session["token"]
        .as_str()
        .ok_or_else(ApiError::internal)?
        .to_owned();
    session
        .as_object_mut()
        .ok_or_else(ApiError::internal)?
        .remove("token");
    let csrf = secret();
    session["csrfToken"] = json!(csrf);
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .cookie(cookie(SESSION_COOKIE, token, state, true))
        .cookie(cookie(CSRF_COOKIE, csrf, state, false))
        .json(session))
}
fn cleared(state: &AppState) -> HttpResponse {
    let mut expired = cookie(SESSION_COOKIE, String::new(), state, true);
    expired.make_removal();
    HttpResponse::NoContent()
        .insert_header(("Cache-Control", "no-store"))
        .cookie(expired)
        .finish()
}
async fn public_config(req: HttpRequest, state: web::Data<AppState>) -> Result<HttpResponse> {
    let csrf = req
        .cookie(CSRF_COOKIE)
        .filter(|c| c.value().len() >= 32)
        .map(|c| c.value().to_owned())
        .unwrap_or_else(secret);
    let settings = state.store.site_settings().await?;
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .cookie(cookie(CSRF_COOKIE, csrf.clone(), &state, false))
        .json(json!({
            "webUrl": state.auth.config.web_url,
            "registrationEnabled": state.store.registration_enabled().await?,
            "termsOfServiceUrl": settings.terms_of_service_url,
            "privacyTermsUrl": settings.privacy_terms_url,
            "csrfToken": csrf,
        })))
}
pub async fn me(req: HttpRequest, state: web::Data<AppState>) -> Result<HttpResponse> {
    let auth = user(&req, &state).await?;
    let csrf = req
        .cookie(CSRF_COOKIE)
        .map(|c| c.value().to_owned())
        .unwrap_or_else(secret);
    Ok(HttpResponse::Ok().insert_header(("Cache-Control","no-store")).cookie(cookie(CSRF_COOKIE,csrf.clone(),&state,false)).json(json!({"user":auth.user,"sessionId":auth.id,"siteAdmin":state.store.is_site_admin(&auth.user.id).await?,"csrfToken":csrf})))
}
pub async fn logout(req: HttpRequest, state: web::Data<AppState>) -> Result<HttpResponse> {
    let auth = user(&req, &state).await?;
    let peers = state
        .store
        .revoke_user_sessions(&auth.user.id, Some(&auth.id))
        .await?;
    state.hub.revoke(peers, "logout").await?;
    state.hub.disconnect_login(&auth.id).await?;
    Ok(cleared(&state))
}

#[cfg(test)]
mod proxy_tests {
    use super::*;
    #[test]
    fn forwarded_address_requires_an_explicitly_trusted_peer() {
        let mut config = config::AuthConfig::development("http://localhost");
        let req = actix_web::test::TestRequest::get()
            .peer_addr("127.0.0.1:9000".parse().unwrap())
            .insert_header(("X-Real-IP", "192.0.2.8"))
            .to_http_request();
        assert_eq!(client_ip(&req, &config).unwrap().to_string(), "127.0.0.1");
        config.trusted_proxy_ips.push("127.0.0.1".parse().unwrap());
        assert_eq!(client_ip(&req, &config).unwrap().to_string(), "192.0.2.8");
        let invalid = actix_web::test::TestRequest::get()
            .peer_addr("127.0.0.1:9000".parse().unwrap())
            .insert_header(("X-Real-IP", "192.0.2.8, 192.0.2.9"))
            .to_http_request();
        assert_eq!(
            client_ip(&invalid, &config).unwrap().to_string(),
            "127.0.0.1"
        );
    }
}
