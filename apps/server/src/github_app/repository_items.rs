use super::repository::{RepositoryClient, upstream_error, valid_repository};
use crate::{
    AppState, auth,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::num::NonZeroU64;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum ItemKind {
    Issue,
    PullRequest,
}

impl ItemKind {
    fn operation(self) -> &'static str {
        match self {
            Self::Issue => "RepositoryIssues",
            Self::PullRequest => "RepositoryPullRequests",
        }
    }

    fn states(self, include_closed: bool) -> &'static [&'static str] {
        match (include_closed, self) {
            (false, _) => &["OPEN"],
            (true, Self::Issue) => &["OPEN", "CLOSED"],
            (true, Self::PullRequest) => &["OPEN", "CLOSED", "MERGED"],
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct List {
    owner: String,
    repo: String,
    kind: ItemKind,
    #[serde(default)]
    include_closed: bool,
    cursor: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all(deserialize = "UPPERCASE", serialize = "lowercase"))]
enum State {
    Open,
    Closed,
    Merged,
}

#[derive(Deserialize)]
struct GitHubItem {
    number: NonZeroU64,
    title: String,
    body: String,
    state: State,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    nodes: Vec<GitHubItem>,
    page_info: PageInfo,
}

#[derive(Deserialize)]
struct Repository {
    items: Connection,
}

#[derive(Deserialize)]
struct Data {
    repository: Option<Repository>,
}

#[derive(Deserialize)]
struct GraphQLError {
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct GraphQLResponse {
    data: Option<Data>,
    #[serde(default)]
    errors: Vec<GraphQLError>,
}

fn inaccessible() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "github_repository_inaccessible",
        "GitHub denied access to this repository or resource",
    )
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
    let response = client
        .graphql(&json!({
            "query": include_str!("repository_items.graphql"),
            "operationName": query.kind.operation(),
            "variables": {
                "owner": query.owner, "repo": query.repo, "cursor": query.cursor,
                "states": query.kind.states(query.include_closed),
            },
        }))
        .await?;
    match response.status() {
        reqwest::StatusCode::OK => (),
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::FORBIDDEN => {
            return Err(inaccessible());
        }
        _ => return Err(upstream_error()),
    }
    // GitHub also returns field-level authorization failures in successful HTTP responses.
    let response: GraphQLResponse = response.json().await.map_err(|_| upstream_error())?;
    if response
        .errors
        .iter()
        .any(|error| matches!(error.kind.as_deref(), Some("FORBIDDEN" | "NOT_FOUND")))
    {
        return Err(inaccessible());
    }
    if !response.errors.is_empty() {
        return Err(upstream_error());
    }
    let connection = response
        .data
        .ok_or_else(upstream_error)?
        .repository
        .ok_or_else(inaccessible)?
        .items;
    let next_cursor = if connection.page_info.has_next_page {
        Some(
            connection
                .page_info
                .end_cursor
                .filter(|value| !value.is_empty())
                .ok_or_else(upstream_error)?,
        )
    } else {
        None
    };
    let repository = format!("{}/{}", query.owner, query.repo);
    let path = match query.kind {
        ItemKind::Issue => "issues",
        ItemKind::PullRequest => "pull",
    };
    let items: Vec<_> = connection.nodes.into_iter().map(|row| json!({
        "kind": query.kind, "repository": repository, "number": row.number, "title": row.title,
        "body": row.body, "state": row.state, "url": format!("https://github.com/{repository}/{path}/{}", row.number),
    })).collect();
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(json!({"items":items,"nextCursor":next_cursor})))
}
