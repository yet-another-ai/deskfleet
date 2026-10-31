//! Google login uses the server's code exchange and HTTPS UserInfo response.
use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct Token {
    access_token: String,
}
#[derive(Deserialize)]
struct Profile {
    sub: String,
    email: Option<String>,
    #[serde(default)]
    email_verified: bool,
    name: Option<String>,
}

pub(super) async fn start(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<oauth::Start>,
) -> Result<HttpResponse> {
    oauth::start(oauth::Provider::Google, req, state, body).await
}
pub(super) async fn callback(
    req: HttpRequest,
    state: web::Data<AppState>,
    query: web::Query<oauth::Callback>,
) -> Result<HttpResponse> {
    oauth::callback(oauth::Provider::Google, req, state, query).await
}
pub(super) async fn complete(
    state: &AppState,
    attempt: &Value,
    code: Option<&str>,
) -> std::result::Result<Value, &'static str> {
    let config = state.auth.config.google.as_ref().ok_or("failed")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "failed")?;
    let token: Token = client
        .post(&config.token_url)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", config.client_id.as_str()),
            ("client_secret", config.client_secret.as_str()),
            ("code", code.ok_or("failed")?),
            ("redirect_uri", config.callback_url.as_str()),
            (
                "code_verifier",
                attempt["verifier"].as_str().ok_or("failed")?,
            ),
        ])
        .send()
        .await
        .map_err(|_| "failed")?
        .error_for_status()
        .map_err(|_| "failed")?
        .json()
        .await
        .map_err(|_| "failed")?;
    // Claims come directly from Google's UserInfo endpoint using the access token
    // obtained above. Browser-supplied tokens and unverified ID tokens are not used.
    let profile: Profile = client
        .get(&config.userinfo_url)
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(|_| "failed")?
        .error_for_status()
        .map_err(|_| "failed")?
        .json()
        .await
        .map_err(|_| "failed")?;
    if profile.sub.trim().is_empty() || profile.sub.len() > 255 {
        return Err("failed");
    }
    let generation = attempt["generation"].as_i64().ok_or("failed")?;
    match state.store.google_account(&profile.sub).await {
        Ok(user) => {
            if attempt["sessionId"].is_string() {
                return oauth::refresh(state, attempt, &user.id).await;
            }
            return state
                .store
                .new_session_at_generation(&user.id, generation)
                .await
                .map_err(|_| "failed");
        }
        Err(deskfleet_control_store::Error::NotFound) => {}
        Err(_) => return Err("failed"),
    }
    if attempt["sessionId"].is_string() {
        return Err("failed");
    }
    if !profile.email_verified {
        return Err("failed");
    }
    let email = profile.email.as_deref().ok_or("failed")?;
    let user = state
        .store
        .google_user(
            &profile.sub,
            email,
            profile
                .name
                .as_deref()
                .filter(|name| !name.trim().is_empty())
                .unwrap_or(email),
            attempt["acceptedTerms"].as_bool().unwrap_or(false),
        )
        .await
        .map_err(|error| match error {
            deskfleet_control_store::Error::Invalid("registration disabled") => {
                "registration_disabled"
            }
            deskfleet_control_store::Error::Invalid("terms acceptance required") => {
                "terms_required"
            }
            deskfleet_control_store::Error::Conflict(_) => "email_conflict",
            _ => "failed",
        })?;
    state
        .store
        .new_session_at_generation(&user.id, generation)
        .await
        .map_err(|_| "failed")
}
