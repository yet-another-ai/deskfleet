use super::repository::{RepositoryClient, upstream_error, valid_repository};
use crate::{
    AppState, auth,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::num::NonZeroU32;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum ItemKind {
    Issue,
    PullRequest,
}

impl ItemKind {
    fn resource(self) -> &'static str {
        match self {
            Self::Issue => "issues",
            Self::PullRequest => "pulls",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct List {
    owner: String,
    repo: String,
    kind: ItemKind,
    page: Option<NonZeroU32>,
}

#[derive(Deserialize)]
struct GitHubItem {
    number: std::num::NonZeroU64,
    title: String,
    body: Option<String>,
    pull_request: Option<serde::de::IgnoredAny>,
}

pub(super) async fn list(
    req: HttpRequest,
    state: web::Data<AppState>,
    query: web::Query<List>,
) -> Result<HttpResponse> {
    let user = auth::user(&req, &state).await?;
    if !valid_repository(&query.owner, &query.repo) {
        return Err(ApiError::bad("invalid GitHub repository"));
    }
    let client = RepositoryClient::for_user(&state, &user.user.id).await?;
    let page = query.page.unwrap_or(NonZeroU32::MIN).get();
    let mut url = client.url(&query.owner, &query.repo, query.kind.resource())?;
    url.query_pairs_mut()
        .append_pair("state", "open")
        .append_pair("sort", "updated")
        .append_pair("direction", "desc")
        .append_pair("per_page", "30")
        .append_pair("page", &page.to_string());
    let response = client.get(url).await?;
    match response.status() {
        reqwest::StatusCode::OK => (),
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::FORBIDDEN => {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "github_repository_inaccessible",
                "GitHub denied access to this repository or resource",
            ));
        }
        _ => return Err(upstream_error()),
    }
    // GitHub includes pull requests in the issues endpoint. Follow its pagination
    // even when filtering those rows leaves an entire issues page empty.
    let next_page = response
        .headers()
        .get_all(reqwest::header::LINK)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|link| {
            link.split(';')
                .skip(1)
                .any(|param| param.trim() == "rel=\"next\"")
        })
        .then(|| page.checked_add(1))
        .flatten();
    let rows: Vec<GitHubItem> = response.json().await.map_err(|_| upstream_error())?;
    let repository = format!("{}/{}", query.owner, query.repo);
    let kind = query.kind;
    let path = match kind {
        ItemKind::Issue => "issues",
        ItemKind::PullRequest => "pull",
    };
    let items: Vec<_> = rows
        .into_iter()
        .filter(|row| matches!(kind, ItemKind::PullRequest) || row.pull_request.is_none())
        .map(|row| {
            json!({
                "kind": kind, "repository": repository, "number": row.number, "title": row.title,
                "body": row.body.unwrap_or_default(),
                "url": format!("https://github.com/{repository}/{path}/{}", row.number),
            })
        })
        .collect();
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(json!({"items":items,"nextPage":next_page})))
}
