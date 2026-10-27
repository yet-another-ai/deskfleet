//! OIDC authorization code flow with PKCE, nonce verification and one-use app codes.
use crate::{
    AppState,
    config::OidcConfig,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, HttpResponse, web};
use deskfleet_control_store::{AuthSession, MachineAuth, secret, secret_hash};
use openidconnect::{
    AccessTokenHash, AuthorizationCode, ClaimsVerificationError, ClientId, ClientSecret, CsrfToken,
    IssuerUrl, Nonce, OAuth2TokenResponse, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope,
    SignatureVerificationError, TokenResponse,
    core::{CoreAuthenticationFlow, CoreClient, CoreJsonWebKeySet, CoreProviderMetadata},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct Oidc {
    config: OidcConfig,
    metadata: Mutex<Arc<CoreProviderMetadata>>,
    http: reqwest::Client,
}
impl Oidc {
    pub async fn discover(config: OidcConfig) -> Result<Self> {
        let issuer = IssuerUrl::new(config.issuer.clone())
            .map_err(|_| ApiError::bad("invalid OIDC issuer"))?;
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|_| ApiError::internal())?;
        let metadata = CoreProviderMetadata::discover_async(issuer, &http)
            .await
            .map_err(|_| ApiError::bad("OIDC provider discovery failed"))?;
        Ok(Self {
            config,
            metadata: Mutex::new(Arc::new(metadata)),
            http,
        })
    }
    fn return_to(&self, value: &str) -> bool {
        allowed_return_to(&self.config.return_to, value)
    }
    async fn metadata(&self) -> Arc<CoreProviderMetadata> {
        self.metadata.lock().await.clone()
    }
    async fn refresh_keys(
        &self,
        previous: &Arc<CoreProviderMetadata>,
    ) -> Result<Arc<CoreProviderMetadata>> {
        // Serialize only a missing-key refresh. Concurrent callbacks that used
        // the same cache reuse its replacement instead of fetching again.
        let mut metadata = self.metadata.lock().await;
        if Arc::ptr_eq(&metadata, previous) {
            let keys = CoreJsonWebKeySet::fetch_async(metadata.jwks_uri(), &self.http)
                .await
                .map_err(|_| ApiError::unauthorized())?;
            *metadata = Arc::new((**metadata).clone().set_jwks(keys));
        }
        Ok(metadata.clone())
    }
}
fn allowed_return_to(allowlist: &[String], value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return false;
    }
    allowlist.iter().any(|allowed| {
        allowed == value
            || (allowed == "http://127.0.0.1:*/auth/callback"
                && url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port().is_some()
                && url.path() == "/auth/callback"
                && url.query().is_none())
    })
}

pub async fn user(req: &HttpRequest, state: &AppState) -> Result<AuthSession> {
    Ok(state.store.authenticate(bearer(req)?).await?)
}
pub async fn machine(req: &HttpRequest, state: &AppState) -> Result<MachineAuth> {
    Ok(state.store.authenticate_machine(bearer(req)?).await?)
}
fn bearer(req: &HttpRequest) -> Result<&str> {
    req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|s| !s.is_empty() && s.len() < 512)
        .ok_or_else(ApiError::unauthorized)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Start {
    return_to: String,
}
pub async fn start(state: web::Data<AppState>, body: web::Json<Start>) -> Result<web::Json<Value>> {
    let oidc = state
        .oidc
        .as_ref()
        .ok_or_else(|| ApiError::bad("OIDC login is not configured"))?;
    if !oidc.return_to(&body.return_to) {
        return Err(ApiError::bad("login return URL is not allowed"));
    }
    let client = CoreClient::from_provider_metadata(
        (*oidc.metadata().await).clone(),
        ClientId::new(oidc.config.client_id.clone()),
        oidc.config.client_secret.clone().map(ClientSecret::new),
    )
    .set_redirect_uri(
        RedirectUrl::new(oidc.config.callback_url.clone()).map_err(|_| ApiError::internal())?,
    );
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (url, csrf, nonce) = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            CsrfToken::new_random,
            Nonce::new_random,
        )
        .add_scope(Scope::new("profile".into()))
        .add_scope(Scope::new("email".into()))
        .set_pkce_challenge(challenge)
        .url();
    let login_verifier = secret();
    state.store.save_login_attempt(csrf.secret(),json!({"returnTo":body.return_to,"nonce":nonce.secret(),"pkce":verifier.secret(),"loginVerifierHash":secret_hash(&login_verifier)})).await?;
    Ok(web::Json(
        json!({"authorizationUrl":url.to_string(),"loginVerifier":login_verifier}),
    ))
}
#[derive(Deserialize)]
pub struct Callback {
    code: Option<String>,
    state: String,
    error: Option<String>,
}
pub async fn callback(
    state: web::Data<AppState>,
    query: web::Query<Callback>,
) -> Result<HttpResponse> {
    let oidc = state.oidc.as_ref().ok_or_else(ApiError::unauthorized)?;
    let attempt = state.store.consume_login_attempt(&query.state).await?;
    if query.error.is_some() {
        return Err(ApiError::unauthorized());
    }
    let code = query.code.clone().ok_or_else(ApiError::unauthorized)?;
    let metadata = oidc.metadata().await;
    let mut client = CoreClient::from_provider_metadata(
        (*metadata).clone(),
        ClientId::new(oidc.config.client_id.clone()),
        oidc.config.client_secret.clone().map(ClientSecret::new),
    )
    .set_redirect_uri(
        RedirectUrl::new(oidc.config.callback_url.clone()).map_err(|_| ApiError::internal())?,
    );
    let tokens = client
        .exchange_code(AuthorizationCode::new(code))
        .map_err(|_| ApiError::unauthorized())?
        .set_pkce_verifier(PkceCodeVerifier::new(field(&attempt, "pkce")?.into()))
        .request_async(&oidc.http)
        .await
        .map_err(|_| ApiError::unauthorized())?;
    let token = tokens.id_token().ok_or_else(ApiError::unauthorized)?;
    let nonce = Nonce::new(field(&attempt, "nonce")?.into());
    let verification = token.claims(&client.id_token_verifier(), &nonce);
    let claims = match verification {
        Ok(claims) => claims,
        Err(ClaimsVerificationError::SignatureVerification(
            SignatureVerificationError::NoMatchingKey,
        )) => {
            // The authorization code has already been consumed. Refresh only
            // the trusted JWKS, then reverify this same token exactly once.
            client = CoreClient::from_provider_metadata(
                (*oidc.refresh_keys(&metadata).await?).clone(),
                ClientId::new(oidc.config.client_id.clone()),
                oidc.config.client_secret.clone().map(ClientSecret::new),
            );
            token
                .claims(&client.id_token_verifier(), &nonce)
                .map_err(|_| ApiError::unauthorized())?
        }
        Err(_) => return Err(ApiError::unauthorized()),
    };
    let verifier = client.id_token_verifier();
    if let Some(expected) = claims.access_token_hash() {
        let actual = AccessTokenHash::from_token(
            tokens.access_token(),
            token.signing_alg().map_err(|_| ApiError::unauthorized())?,
            token
                .signing_key(&verifier)
                .map_err(|_| ApiError::unauthorized())?,
        )
        .map_err(|_| ApiError::unauthorized())?;
        if actual != *expected {
            return Err(ApiError::unauthorized());
        }
    }
    let name = claims
        .name()
        .and_then(|n| n.get(None))
        .map(|s| s.as_str())
        .unwrap_or(claims.subject().as_str());
    let user = state
        .store
        .oidc_user(
            &oidc.config.issuer,
            claims.subject().as_str(),
            name,
            claims.email().map(|s| s.as_str()),
            claims.email_verified().unwrap_or(false),
        )
        .await?;
    let code = state
        .store
        .new_login_code(&user.id, field(&attempt, "loginVerifierHash")?)
        .await?;
    let mut url =
        url::Url::parse(field(&attempt, "returnTo")?).map_err(|_| ApiError::internal())?;
    url.set_fragment(Some(&format!("loginCode={code}")));
    Ok(HttpResponse::Found()
        .insert_header(("Location", url.to_string()))
        .insert_header(("Cache-Control", "no-store"))
        .finish())
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or_else(ApiError::internal)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Exchange {
    code: String,
    login_verifier: String,
}
pub async fn exchange(
    state: web::Data<AppState>,
    body: web::Json<Exchange>,
) -> Result<web::Json<Value>> {
    Ok(web::Json(
        state
            .store
            .exchange_login_code(&body.code, &body.login_verifier)
            .await?,
    ))
}
pub async fn me(req: HttpRequest, state: web::Data<AppState>) -> Result<web::Json<Value>> {
    let auth = user(&req, &state).await?;
    let site_admin = state.store.is_site_admin(&auth.user.id).await?;
    Ok(web::Json(
        json!({"user":auth.user,"sessionId":auth.id,"siteAdmin":site_admin}),
    ))
}
pub async fn logout(req: HttpRequest, state: web::Data<AppState>) -> Result<web::Json<Value>> {
    let auth = user(&req, &state).await?;
    state.store.logout(&auth.id).await?;
    let peers = state.store.revoke_login_peers(&auth.id).await?;
    state.hub.revoke(peers, "logout").await;
    Ok(web::Json(json!({})))
}

#[cfg(test)]
mod tests {
    #[test]
    fn callback_allowlist_only_accepts_exact_web_or_loopback_port() {
        let allowed = vec![
            "https://app.example/auth/callback".into(),
            "http://127.0.0.1:*/auth/callback".into(),
        ];
        for value in [
            "https://app.example/auth/callback",
            "http://127.0.0.1:49152/auth/callback",
        ] {
            assert!(super::allowed_return_to(&allowed, value));
        }
        for value in [
            "https://app.example.evil/auth/callback",
            "https://app.example/auth/callback?next=evil",
            "http://localhost:49152/auth/callback",
            "http://127.0.0.1:49152/other",
            "http://user@127.0.0.1:49152/auth/callback",
            "http://127.0.0.1:49152/auth/callback#fragment",
            "http://127.0.0.1:49152/auth/callback?query",
        ] {
            assert!(!super::allowed_return_to(&allowed, value), "{value}");
        }
    }
}
