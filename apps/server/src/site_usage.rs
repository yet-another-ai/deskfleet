//! Installation-wide usage is available only through current site administrator grants.
use actix_web::{HttpRequest, web};
use serde::Deserialize;
use serde_json::Value;

use crate::{AppState, auth, error::Result};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UsageQuery {
    period: String,
}

pub(crate) async fn read(
    req: HttpRequest,
    state: web::Data<AppState>,
    query: web::Query<UsageQuery>,
) -> Result<web::Json<Value>> {
    let actor = auth::user(&req, &state).await?;
    Ok(web::Json(
        state
            .store
            .site_usage_trends(&actor.user.id, &query.period)
            .await?,
    ))
}

#[cfg(test)]
mod tests;
