//! Authenticated Team usage queries; aggregation belongs to the control store.
use actix_web::{HttpRequest, web};
use serde::Deserialize;
use serde_json::Value;

use crate::{AppState, auth, error::Result};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SummaryQuery {
    period: String,
    time_zone: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionsQuery {
    date: String,
    time_zone: String,
}

pub(crate) async fn summary(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
    query: web::Query<SummaryQuery>,
) -> Result<web::Json<Value>> {
    let actor = auth::user(&req, &state).await?;
    Ok(web::Json(
        state
            .store
            .team_ai_usage(&actor.user.id, &path, &query.period, &query.time_zone)
            .await?,
    ))
}

pub(crate) async fn sessions(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
    query: web::Query<SessionsQuery>,
) -> Result<web::Json<Value>> {
    let actor = auth::user(&req, &state).await?;
    Ok(web::Json(
        state
            .store
            .team_ai_usage_sessions(&actor.user.id, &path, &query.date, &query.time_zone)
            .await?,
    ))
}

#[cfg(test)]
mod tests;
