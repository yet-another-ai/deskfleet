use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct Token {
    access_token: String,
}
#[derive(Deserialize)]
struct Profile {
    id: u64,
    login: String,
    name: Option<String>,
}
#[derive(Deserialize)]
struct Email {
    email: String,
    verified: bool,
    primary: bool,
}

pub(super) async fn start(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<oauth::Start>,
) -> Result<HttpResponse> {
    oauth::start(oauth::Provider::Github, req, state, body).await
}
pub(super) async fn callback(
    req: HttpRequest,
    state: web::Data<AppState>,
    query: web::Query<oauth::Callback>,
) -> Result<HttpResponse> {
    oauth::callback(oauth::Provider::Github, req, state, query).await
}
pub(super) async fn complete(
    state: &AppState,
    attempt: &Value,
    code: Option<&str>,
) -> std::result::Result<Value, &'static str> {
    let config = state.auth.config.github.as_ref().ok_or("failed")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "failed")?;
    let token: Token = client
        .post(&config.token_url)
        .header("Accept", "application/json")
        .form(&[
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
    let profile: Profile = client
        .get(&config.user_url)
        .header("User-Agent", "DeskFleet")
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(|_| "failed")?
        .error_for_status()
        .map_err(|_| "failed")?
        .json()
        .await
        .map_err(|_| "failed")?;
    let generation = attempt["generation"].as_i64().ok_or("failed")?;
    match state.store.github_account(&profile.id.to_string()).await {
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
    let emails: Vec<Email> = client
        .get(&config.emails_url)
        .header("User-Agent", "DeskFleet")
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(|_| "failed")?
        .error_for_status()
        .map_err(|_| "failed")?
        .json()
        .await
        .map_err(|_| "failed")?;
    let email = emails
        .iter()
        .find(|e| e.verified && e.primary)
        .or_else(|| emails.iter().find(|e| e.verified))
        .ok_or("failed")?;
    let user = state
        .store
        .github_user(
            &profile.id.to_string(),
            &email.email,
            profile
                .name
                .as_deref()
                .filter(|n| !n.trim().is_empty())
                .unwrap_or(&profile.login),
            attempt["acceptedTerms"].as_bool().unwrap_or(false),
        )
        .await
        .map_err(|e| match e {
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
