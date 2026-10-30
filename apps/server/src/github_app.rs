//! Optional GitHub App integration; this never logs a user into DeskFleet.
mod config;
mod pull_requests;
pub use config::GithubAppConfig;

use crate::{
    AppState, auth,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, HttpResponse, cookie::time::Duration, web};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use deskfleet_control_store::{GithubAppGrant, GithubAppStatus, GithubAppTokens, now_ms, secret};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const STATE_COOKIE: &str = "deskfleet_github_app_state";

pub(crate) fn configure(config: &mut web::ServiceConfig) {
    config
        .route("/integrations/github", web::get().to(settings))
        .route("/integrations/github", web::patch().to(update))
        .route(
            "/integrations/github/pull-request",
            web::get().to(pull_requests::lookup),
        )
        .route(
            "/integrations/github/authorization/start",
            web::post().to(start),
        )
        .route("/integrations/github/callback", web::get().to(callback));
}

async fn status(state: &AppState, user_id: &str) -> Result<Value> {
    let (config, grant) = match &state.config.github_app {
        Some(config) => (
            Some(config),
            state
                .store
                .github_app_status(user_id, &config.client_id)
                .await?,
        ),
        None => (None, GithubAppStatus::default()),
    };
    Ok(json!({
        "configured": config.is_some(),
        "manageUrl": config.map(GithubAppConfig::manage_url),
        "authorized": grant.authorized,
        "login": grant.login,
        "actAsYou": grant.act_as_you,
    }))
}

async fn settings(req: HttpRequest, state: web::Data<AppState>) -> Result<HttpResponse> {
    let user = auth::user(&req, &state).await?;
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(status(&state, &user.user.id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    act_as_you: bool,
}

async fn update(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Update>,
) -> Result<HttpResponse> {
    let user = auth::user(&req, &state).await?;
    let config = state
        .config
        .github_app
        .as_ref()
        .ok_or_else(ApiError::forbidden)?;
    state
        .store
        .set_github_act_as_you(&user.user.id, &config.client_id, body.act_as_you)
        .await?;
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(status(&state, &user.user.id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    expected_user_id: String,
}

async fn start(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Start>,
) -> Result<HttpResponse> {
    // The browser confirmation page binds desktop handoffs to the signed-in account.
    // A bearer-only request must never create a link that someone else can authorize.
    if req.headers().contains_key("authorization") {
        return Err(ApiError::forbidden());
    }
    auth::browser_mutation(&req, &state)?;
    let user = state
        .store
        .authenticate(&auth::cookie_token(&req).ok_or_else(ApiError::unauthorized)?)
        .await?;
    if user.user.id != body.expected_user_id {
        return Err(ApiError::forbidden());
    }
    auth::limit(&req, &state, "github_app_start", None).await?;
    let config = state
        .config
        .github_app
        .as_ref()
        .ok_or_else(ApiError::forbidden)?;
    let nonce = secret();
    let verifier = secret();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    state
        .store
        .save_login_attempt(
            &nonce,
            json!({
                "kind":"github-app", "userId":user.user.id, "sessionId":user.id,
                "clientId":config.client_id, "verifier":verifier,
            }),
        )
        .await?;
    let mut authorization = url::Url::parse("https://github.com/login/oauth/authorize")
        .map_err(|_| ApiError::internal())?;
    authorization
        .query_pairs_mut()
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", &config.callback_url)
        .append_pair("state", &nonce)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    let mut cookie = auth::cookie(STATE_COOKIE, nonce, &state, true);
    cookie.set_max_age(Duration::minutes(10));
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .cookie(cookie)
        .json(json!({"authorizationUrl":authorization.as_str()})))
}

#[derive(Deserialize)]
struct Callback {
    state: Option<String>,
    code: Option<String>,
}

async fn callback(
    req: HttpRequest,
    state: web::Data<AppState>,
    query: web::Query<Callback>,
) -> Result<HttpResponse> {
    auth::limit(&req, &state, "github_app_callback", None).await?;
    let nonce = query.state.as_deref().ok_or_else(ApiError::unauthorized)?;
    if !req
        .cookie(STATE_COOKIE)
        .is_some_and(|cookie| cookie.value() == nonce)
    {
        return Err(ApiError::unauthorized());
    }
    let attempt = state.store.consume_login_attempt(nonce).await?;
    if attempt["kind"] != "github-app" {
        return Err(ApiError::unauthorized());
    }
    let user_id = attempt["userId"]
        .as_str()
        .ok_or_else(ApiError::unauthorized)?;
    let completed = complete(&req, &state, &attempt, query.code.as_deref())
        .await
        .is_ok();
    let mut destination =
        url::Url::parse(&format!("{}/auth/github-app", state.auth.config.web_url))
            .map_err(|_| ApiError::internal())?;
    destination
        .query_pairs_mut()
        .append_pair("user", user_id)
        .append_pair(
            "githubAppResult",
            if completed { "authorized" } else { "failed" },
        );
    let mut cookie = auth::cookie(STATE_COOKIE, String::new(), &state, true);
    cookie.make_removal();
    Ok(HttpResponse::Found()
        .insert_header(("Location", destination.as_str()))
        .insert_header(("Cache-Control", "no-store"))
        .insert_header(("Referrer-Policy", "no-referrer"))
        .cookie(cookie)
        .finish())
}

#[derive(Deserialize)]
struct Token {
    access_token: String,
    token_type: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    refresh_token_expires_in: Option<u64>,
}
impl Token {
    fn into_tokens(self) -> std::result::Result<GithubAppTokens, ()> {
        if self.access_token.is_empty() || !self.token_type.eq_ignore_ascii_case("bearer") {
            return Err(());
        }
        let issued_at = now_ms();
        let expires_at = expiry(issued_at, self.expires_in)?;
        let refresh_expires_at = expiry(issued_at, self.refresh_token_expires_in)?;
        if self
            .refresh_token
            .as_ref()
            .is_some_and(|token| token.is_empty())
            || self.refresh_token.is_some() != refresh_expires_at.is_some()
        {
            return Err(());
        }
        Ok(GithubAppTokens {
            access_token: self.access_token,
            expires_at,
            refresh_token: self.refresh_token,
            refresh_expires_at,
        })
    }
}
#[derive(Deserialize)]
struct Profile {
    id: u64,
    login: String,
}

async fn complete(
    req: &HttpRequest,
    state: &AppState,
    attempt: &Value,
    code: Option<&str>,
) -> std::result::Result<(), ()> {
    let config = state.config.github_app.as_ref().ok_or(())?;
    if attempt["clientId"].as_str() != Some(&config.client_id) {
        return Err(());
    }
    let user = state
        .store
        .authenticate(&auth::cookie_token(req).ok_or(())?)
        .await
        .map_err(|_| ())?;
    if attempt["userId"].as_str() != Some(&user.user.id)
        || attempt["sessionId"].as_str() != Some(&user.id)
    {
        return Err(());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| ())?;
    let token: Token = client
        .post(&config.token_url)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", config.client_id.as_str()),
            ("client_secret", config.client_secret.as_str()),
            ("redirect_uri", config.callback_url.as_str()),
            ("code", code.ok_or(())?),
            ("code_verifier", attempt["verifier"].as_str().ok_or(())?),
        ])
        .send()
        .await
        .map_err(|_| ())?
        .error_for_status()
        .map_err(|_| ())?
        .json()
        .await
        .map_err(|_| ())?;
    let token = token.into_tokens()?;
    let profile: Profile = client
        .get(&config.user_url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "DeskFleet")
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(|_| ())?
        .error_for_status()
        .map_err(|_| ())?
        .json()
        .await
        .map_err(|_| ())?;
    if profile.id == 0 || profile.login.is_empty() {
        return Err(());
    }
    state
        .store
        .save_github_app_grant(
            &user.user.id,
            &user.id,
            &config.client_id,
            GithubAppGrant {
                subject: profile.id.to_string(),
                login: profile.login,
                access_token: token.access_token,
                expires_at: token.expires_at,
                refresh_token: token.refresh_token,
                refresh_expires_at: token.refresh_expires_at,
            },
        )
        .await
        .map_err(|_| ())
}

fn expiry(issued_at: i64, seconds: Option<u64>) -> std::result::Result<Option<i64>, ()> {
    seconds
        .map(|seconds| {
            i64::try_from(seconds)
                .ok()
                .and_then(|seconds| seconds.checked_mul(1000))
                .and_then(|ms| issued_at.checked_add(ms))
                .ok_or(())
        })
        .transpose()
}
