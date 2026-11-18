//! Read branch pull-request state using the account's explicitly enabled App grant.
use super::repository::{RepositoryClient, upstream_error, valid_owner, valid_repository};
use crate::{
    AppState, auth,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, HttpResponse, web};
use deskfleet_control_store::policies::MachineAction;
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
        if !valid_repository(&self.owner, &self.repo)
            || self
                .head_owner
                .as_deref()
                .is_some_and(|value| !valid_owner(value))
            || self.branch.is_empty()
            || self.branch.len() > 1024
            || self.branch.chars().any(char::is_control)
        {
            return Err(ApiError::bad("invalid GitHub repository or branch"));
        }
        Ok(())
    }

    fn url(&self, client: &RepositoryClient, state: &str) -> Result<url::Url> {
        let mut url = client.url(&self.owner, &self.repo, "pulls")?;
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

pub(super) async fn lookup(
    req: HttpRequest,
    state: web::Data<AppState>,
    query: web::Query<Lookup>,
) -> Result<HttpResponse> {
    let user = auth::user(&req, &state).await?;
    lookup_for_user(&state, &user.user.id, &query).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DelegatedLookup {
    user_id: String,
    query: Lookup,
}

/// A registration may use a saved Session author's current, opted-in GitHub grant.
/// Machine identity and Team authorization always come from the machine token.
pub(super) async fn daemon_lookup(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<DelegatedLookup>,
) -> Result<HttpResponse> {
    let machine = auth::machine(&req, &state).await?;
    state
        .store
        .authorize_machine(&body.user_id, &machine.machine.id, MachineAction::Manage)
        .await?;
    lookup_for_user(&state, &body.user_id, &body.query).await
}

async fn lookup_for_user(state: &AppState, user_id: &str, query: &Lookup) -> Result<HttpResponse> {
    query.validate()?;
    let client = RepositoryClient::for_user(state, user_id).await?;
    let mut pull_request = None;
    // Query open first so a reused branch's active PR wins over older PR activity,
    // without requiring pagination through all of its historical pull requests.
    for state in ["open", "closed"] {
        let response = client.get(query.url(&client, state)?).await?;
        if !response.status().is_success() {
            return Err(upstream_error());
        }
        let pulls: Vec<PullRequest> = response.json().await.map_err(|_| upstream_error())?;
        if let Some(pull) = pulls.into_iter().next() {
            pull_request = Some(pull.status(query)?);
            break;
        }
    }
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(json!({"pullRequest": pull_request})))
}
