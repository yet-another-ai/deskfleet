//! Read branch pull-request state using the account's explicitly enabled App grant.
use super::{GithubAppConfig, Token};
use crate::{
    AppState, auth,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use deskfleet_control_store::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Lookup {
    owner: String,
    repo: String,
    branch: String,
    head_owner: Option<String>,
}

impl Lookup {
    fn validate(&self) -> Result<()> {
        let owner = |value: &str| {
            !value.is_empty()
                && value.len() <= 100
                && value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        };
        let repo = !self.repo.is_empty()
            && self.repo.len() <= 100
            && self.repo != "."
            && self.repo != ".."
            && self
                .repo
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c));
        if !owner(&self.owner)
            || !repo
            || self
                .head_owner
                .as_deref()
                .is_some_and(|value| !owner(value))
            || self.branch.is_empty()
            || self.branch.len() > 1024
            || self.branch.chars().any(char::is_control)
        {
            return Err(ApiError::bad("invalid GitHub repository or branch"));
        }
        Ok(())
    }

    fn url(&self, config: &GithubAppConfig, state: &str) -> Result<url::Url> {
        let mut url = url::Url::parse(&config.api_url).map_err(|_| ApiError::internal())?;
        url.path_segments_mut()
            .map_err(|_| ApiError::internal())?
            .extend(["repos", &self.owner, &self.repo, "pulls"]);
        let head = format!(
            "{}:{}",
            self.head_owner.as_deref().unwrap_or(&self.owner),
            self.branch
        );
        url.query_pairs_mut()
            .append_pair("head", &head)
            .append_pair("state", state)
            .append_pair("sort", "updated")
            .append_pair("direction", "desc")
            .append_pair("per_page", "1");
        Ok(url)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum State {
    Open,
    Closed,
}

#[derive(Deserialize)]
struct PullRequest {
    number: u64,
    title: String,
    state: State,
    draft: bool,
    merged_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum PullRequestState {
    Draft,
    Open,
    Merged,
    Closed,
}

#[derive(Serialize)]
struct PullRequestStatus {
    number: u64,
    title: String,
    url: String,
    state: PullRequestState,
}

impl PullRequest {
    fn status(self, query: &Lookup) -> Result<PullRequestStatus> {
        if self.number == 0 {
            return Err(upstream_error());
        }
        let state = match self.state {
            State::Closed if self.merged_at.is_some() => PullRequestState::Merged,
            State::Closed => PullRequestState::Closed,
            State::Open if self.draft => PullRequestState::Draft,
            State::Open => PullRequestState::Open,
        };
        Ok(PullRequestStatus {
            number: self.number,
            title: self.title,
            url: format!(
                "https://github.com/{}/{}/pull/{}",
                query.owner, query.repo, self.number
            ),
            state,
        })
    }
}

fn upstream_error() -> ApiError {
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "github_unavailable",
        "GitHub pull request status is unavailable",
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

pub(super) async fn lookup(
    req: HttpRequest,
    state: web::Data<AppState>,
    query: web::Query<Lookup>,
) -> Result<HttpResponse> {
    let user = auth::user(&req, &state).await?;
    query.validate()?;
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
    let token = access_token(&state, &user.user.id, config, &client).await?;
    let mut pull_request = None;
    // Query open first so a reused branch's active PR wins over older PR activity,
    // without requiring pagination through all of its historical pull requests.
    for state in ["open", "closed"] {
        let response = client
            .get(query.url(config, state)?)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "DeskFleet")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|_| upstream_error())?;
        if !response.status().is_success() {
            return Err(upstream_error());
        }
        let pulls: Vec<PullRequest> = response.json().await.map_err(|_| upstream_error())?;
        if let Some(pull) = pulls.into_iter().next() {
            pull_request = Some(pull.status(&query)?);
            break;
        }
    }
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(json!({"pullRequest": pull_request})))
}
