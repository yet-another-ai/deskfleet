//! Browser-bound, single-use OAuth login shared by the configured providers.
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy)]
pub(super) enum Provider {
    Github,
    Google,
}
impl Provider {
    fn kind(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Google => "google",
        }
    }
    fn state_cookie(self) -> &'static str {
        match self {
            Self::Github => "deskfleet_github_state",
            Self::Google => "deskfleet_google_state",
        }
    }
    fn error_parameter(self) -> &'static str {
        match self {
            Self::Github => "githubError",
            Self::Google => "googleError",
        }
    }
    fn authorization_url(self, state: &AppState) -> Result<url::Url> {
        let (endpoint, client_id, callback_url, scope) = match self {
            Self::Github => {
                let config = state
                    .auth
                    .config
                    .github
                    .as_ref()
                    .ok_or_else(ApiError::forbidden)?;
                (
                    "https://github.com/login/oauth/authorize",
                    &config.client_id,
                    &config.callback_url,
                    "user:email",
                )
            }
            Self::Google => {
                let config = state
                    .auth
                    .config
                    .google
                    .as_ref()
                    .ok_or_else(ApiError::forbidden)?;
                (
                    "https://accounts.google.com/o/oauth2/v2/auth",
                    &config.client_id,
                    &config.callback_url,
                    "openid email profile",
                )
            }
        };
        let mut url = url::Url::parse(endpoint).map_err(|_| ApiError::internal())?;
        url.query_pairs_mut()
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", callback_url)
            .append_pair("scope", scope);
        if matches!(self, Self::Google) {
            url.query_pairs_mut().append_pair("response_type", "code");
        }
        Ok(url)
    }
}
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
fn return_url(base: &str, path: &str) -> Option<url::Url> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        return None;
    }
    let origin = url::Url::parse(base).ok()?;
    let url = origin.join(path).ok()?;
    (url.origin() == origin.origin()).then_some(url)
}
pub(super) async fn start(
    provider: Provider,
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Start>,
) -> Result<HttpResponse> {
    browser_mutation(&req, &state)?;
    limit(&req, &state, &format!("{}_start", provider.kind()), None).await?;
    let mut url = provider.authorization_url(&state)?;
    return_url(&state.auth.config.web_url, &body.return_to)
        .ok_or_else(|| ApiError::bad("invalid return path"))?;
    let settings = state.store.site_settings().await?;
    if !body.accepted_terms
        && (!settings.terms_of_service_url.is_empty() || !settings.privacy_terms_url.is_empty())
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "terms_acceptance_required",
            "Accept the terms before signing in.",
        ));
    }
    let nonce = secret();
    let verifier = secret();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    reject_signed_in(&req, &state).await?;
    let generation = state.store.authentication_generation().await?;
    state.store.save_login_attempt(&nonce, json!({"kind":provider.kind(),"returnTo":body.return_to,"acceptedTerms":body.accepted_terms,"verifier":verifier,"generation":generation})).await?;
    url.query_pairs_mut()
        .append_pair("state", &nonce)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    let mut binding = cookie(provider.state_cookie(), nonce, &state, true);
    binding.set_max_age(Duration::minutes(10));
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .cookie(binding)
        .json(json!({"authorizationUrl":url.as_str()})))
}
pub(super) async fn callback(
    provider: Provider,
    req: HttpRequest,
    state: web::Data<AppState>,
    query: web::Query<Callback>,
) -> Result<HttpResponse> {
    limit(&req, &state, &format!("{}_callback", provider.kind()), None).await?;
    let nonce = query.state.as_deref().ok_or_else(ApiError::unauthorized)?;
    if !req
        .cookie(provider.state_cookie())
        .is_some_and(|c| c.value() == nonce)
    {
        return Err(ApiError::unauthorized());
    }
    let attempt = state.store.consume_login_attempt(nonce).await?;
    if attempt["kind"] != provider.kind() {
        return Err(ApiError::unauthorized());
    }
    reject_signed_in(&req, &state).await?;
    let path = attempt["returnTo"]
        .as_str()
        .ok_or_else(ApiError::unauthorized)?;
    let mut target =
        return_url(&state.auth.config.web_url, path).ok_or_else(ApiError::unauthorized)?;
    let result = complete(provider, &state, &attempt, query.code.as_deref()).await;
    let mut binding = cookie(provider.state_cookie(), String::new(), &state, true);
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
            target
                .query_pairs_mut()
                .append_pair(provider.error_parameter(), code);
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
    provider: Provider,
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
    match provider {
        Provider::Github => github::complete(state, attempt, code).await,
        Provider::Google => google::complete(state, attempt, code).await,
    }
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
