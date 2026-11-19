//! Read repository data with the requesting user's explicitly enabled GitHub App grant.
use super::{GithubAppConfig, Token};
use crate::{
    AppState,
    error::{ApiError, Result},
};
use actix_web::http::StatusCode;
use deskfleet_control_store::now_ms;

pub(super) fn valid_owner(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

pub(super) fn valid_repository(owner: &str, repo: &str) -> bool {
    valid_owner(owner)
        && !repo.is_empty()
        && repo.len() <= 100
        && repo != "."
        && repo != ".."
        && repo
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
}

pub(super) struct RepositoryClient<'a> {
    config: &'a GithubAppConfig,
    client: reqwest::Client,
    token: String,
}

impl<'a> RepositoryClient<'a> {
    pub(super) async fn for_user(state: &'a AppState, user_id: &str) -> Result<Self> {
        let config = state
            .config
            .github_app
            .as_ref()
            .ok_or_else(ApiError::forbidden)?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ApiError::internal())?;
        let token = access_token(state, user_id, config, &client).await?;
        Ok(Self {
            config,
            client,
            token,
        })
    }

    pub(super) fn url(&self, owner: &str, repo: &str, resource: &str) -> Result<url::Url> {
        let mut url = url::Url::parse(&self.config.api_url).map_err(|_| ApiError::internal())?;
        url.path_segments_mut()
            .map_err(|_| ApiError::internal())?
            .extend(["repos", owner, repo, resource]);
        Ok(url)
    }

    pub(super) async fn get(&self, url: url::Url) -> Result<reqwest::Response> {
        self.send(self.client.get(url)).await
    }

    pub(super) async fn graphql(&self, body: &serde_json::Value) -> Result<reqwest::Response> {
        let url = format!("{}/graphql", self.config.api_url.trim_end_matches('/'));
        self.send(self.client.post(url).json(body)).await
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response> {
        request
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "DeskFleet")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|_| upstream_error())
    }
}

pub(super) fn upstream_error() -> ApiError {
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "github_unavailable",
        "GitHub repository data is unavailable",
    )
}

async fn access_token(
    state: &AppState,
    user_id: &str,
    config: &GithubAppConfig,
    client: &reqwest::Client,
) -> Result<String> {
    let access = state
        .store
        .github_app_access(user_id, &config.client_id)
        .await?
        .ok_or_else(ApiError::forbidden)?;
    if access
        .tokens
        .expires_at
        .is_none_or(|expires| expires > now_ms())
    {
        return Ok(access.finish(None).await?);
    }
    let refresh_token = access
        .tokens
        .refresh_token
        .as_deref()
        .filter(|_| {
            access
                .tokens
                .refresh_expires_at
                .is_some_and(|expires| expires > now_ms())
        })
        .ok_or_else(ApiError::forbidden)?;
    // Keep the database row locked through this bounded request: GitHub invalidates
    // a refresh token on use, so replicas must never refresh it concurrently.
    let token: Token = client
        .post(&config.token_url)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", config.client_id.as_str()),
            ("client_secret", config.client_secret.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .map_err(|_| upstream_error())?
        .error_for_status()
        .map_err(|_| upstream_error())?
        .json()
        .await
        .map_err(|_| upstream_error())?;
    let token = token.into_tokens().map_err(|_| upstream_error())?;
    Ok(access.finish(Some(token)).await?)
}
