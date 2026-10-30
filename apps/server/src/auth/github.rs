use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const STATE_COOKIE: &str = "deskfleet_github_state";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Start {
    return_to: String,
    #[serde(default)]
    accepted_terms: bool,
}
#[derive(Deserialize)]
pub(super) struct Callback {
    state: Option<String>,
    code: Option<String>,
}
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

fn return_url(base: &str, path: &str) -> Option<url::Url> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        return None;
    }
    let origin = url::Url::parse(base).ok()?;
    let url = origin.join(path).ok()?;
    (url.origin() == origin.origin()).then_some(url)
}
pub(super) async fn start(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Start>,
) -> Result<HttpResponse> {
    browser_mutation(&req, &state)?;
    limit(&req, &state, "github_start", None).await?;
    let config = state
        .auth
        .config
        .github
        .as_ref()
        .ok_or_else(ApiError::forbidden)?;
    return_url(&state.auth.config.web_url, &body.return_to)
        .ok_or_else(|| ApiError::bad("invalid return path"))?;
    let settings = state.store.site_settings().await?;
    if !body.accepted_terms
        && (!settings.terms_of_service_url.is_empty() || !settings.privacy_terms_url.is_empty())
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "terms_acceptance_required",
            "Accept the terms before signing in with GitHub.",
        ));
    }
    let nonce = secret();
    let verifier = secret();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    reject_signed_in(&req, &state).await?;
    let generation = state.store.authentication_generation().await?;
    state.store.save_login_attempt(&nonce, json!({"kind":"github","returnTo":body.return_to,"acceptedTerms":body.accepted_terms,"verifier":verifier,"generation":generation})).await?;
    let mut url = url::Url::parse("https://github.com/login/oauth/authorize")
        .map_err(|_| ApiError::internal())?;
    url.query_pairs_mut()
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", &config.callback_url)
        .append_pair("scope", "user:email")
        .append_pair("state", &nonce)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    let mut binding = cookie(STATE_COOKIE, nonce, &state, true);
    binding.set_max_age(Duration::minutes(10));
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .cookie(binding)
        .json(json!({"authorizationUrl":url.as_str()})))
}
pub(super) async fn callback(
    req: HttpRequest,
    state: web::Data<AppState>,
    query: web::Query<Callback>,
) -> Result<HttpResponse> {
    limit(&req, &state, "github_callback", None).await?;
    let nonce = query.state.as_deref().ok_or_else(ApiError::unauthorized)?;
    if !req.cookie(STATE_COOKIE).is_some_and(|c| c.value() == nonce) {
        return Err(ApiError::unauthorized());
    }
    let attempt = state.store.consume_login_attempt(nonce).await?;
    if attempt["kind"] != "github" {
        return Err(ApiError::unauthorized());
    }
    reject_signed_in(&req, &state).await?;
    let path = attempt["returnTo"]
        .as_str()
        .ok_or_else(ApiError::unauthorized)?;
    let mut target =
        return_url(&state.auth.config.web_url, path).ok_or_else(ApiError::unauthorized)?;
    let result = complete(&req, &state, &attempt, query.code.as_deref()).await;
    let mut binding = cookie(STATE_COOKIE, String::new(), &state, true);
    binding.make_removal();
    match result {
        Ok(session) => {
            let token = session["token"].as_str().ok_or_else(ApiError::internal)?;
            Ok(HttpResponse::Found()
                .insert_header(("Location", target.as_str()))
                .insert_header(("Cache-Control", "no-store"))
                .insert_header(("Referrer-Policy", "no-referrer"))
                .cookie(binding)
                .cookie(cookie(SESSION_COOKIE, token.to_owned(), &state, true))
                .cookie(cookie(CSRF_COOKIE, secret(), &state, false))
                .finish())
        }
        Err(code) => {
            if target.path() == "/" {
                target = return_url(&state.auth.config.web_url, "/auth/login")
                    .ok_or_else(ApiError::internal)?;
            }
            target.query_pairs_mut().append_pair("githubError", code);
            Ok(HttpResponse::Found()
                .insert_header(("Location", target.as_str()))
                .insert_header(("Cache-Control", "no-store"))
                .insert_header(("Referrer-Policy", "no-referrer"))
                .cookie(binding)
                .finish())
        }
    }
}
async fn complete(
    _req: &HttpRequest,
    state: &AppState,
    attempt: &Value,
    code: Option<&str>,
) -> std::result::Result<Value, &'static str> {
    let settings = state.store.site_settings().await.map_err(|_| "failed")?;
    if !attempt["acceptedTerms"].as_bool().unwrap_or(false)
        && (!settings.terms_of_service_url.is_empty() || !settings.privacy_terms_url.is_empty())
    {
        return Err("terms_required");
    }
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
            return state
                .store
                .new_session_at_generation(&user.id, generation)
                .await
                .map_err(|_| "failed");
        }
        Err(deskfleet_control_store::Error::NotFound) => {}
        Err(_) => return Err("failed"),
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
async fn reject_signed_in(req: &HttpRequest, state: &AppState) -> Result<()> {
    if let Some(token) = cookie_token(req) {
        match state.store.authenticate(&token).await {
            Ok(_) => return Err(ApiError::forbidden()),
            Err(deskfleet_control_store::Error::Unauthorized) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn return_paths_stay_on_web_origin() {
        let base = "https://example.test";
        assert!(return_url(base, "/auth/desktop?attempt=abc").is_some());
        assert!(return_url(base, "/auth/email/verify#token=abc").is_some());
        for path in ["//evil.test", "/\\evil.test", "https://evil.test"] {
            assert!(return_url(base, path).is_none());
        }
    }
}
