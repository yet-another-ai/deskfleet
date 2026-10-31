//! Search and schedule read models use central data; execution stays on the daemon.
use actix_web::{HttpRequest, web};
use deskfleet_protocol::control::ControlMessage;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{AppState, auth, error::Result};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SearchQuery {
    q: String,
    #[serde(default = "all_kinds")]
    kind: String,
    cursor: Option<String>,
    #[serde(default = "page_size")]
    limit: u32,
}

fn all_kinds() -> String {
    "all".to_owned()
}

fn page_size() -> u32 {
    30
}

pub(crate) async fn search(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
    query: web::Query<SearchQuery>,
) -> Result<web::Json<Value>> {
    let actor = auth::user(&req, &state).await?;
    Ok(web::Json(
        state
            .store
            .search(
                &actor.user.id,
                &path,
                &query.q,
                &query.kind,
                query.cursor.as_deref(),
                query.limit,
            )
            .await?,
    ))
}

pub(crate) async fn schedules(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> Result<web::Json<Value>> {
    let actor = auth::user(&req, &state).await?;
    state
        .store
        .authorized_machine(&actor.user.id, &path)
        .await?;
    Ok(web::Json(state.store.schedule_snapshot(&path).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ScheduleSync {
    tasks: Vec<Value>,
}

pub(crate) async fn sync_schedules(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<ScheduleSync>,
) -> Result<web::Json<Value>> {
    let machine = auth::machine(&req, &state).await?;
    state
        .store
        .sync_schedules(&machine.machine.id, Value::Array(body.into_inner().tasks))
        .await?;
    state
        .notify_team(
            &machine.machine.team_id,
            ControlMessage::CatalogChanged {
                machine_id: machine.machine.id,
                session_id: None,
            },
        )
        .await?;
    Ok(web::Json(json!({})))
}

#[cfg(test)]
mod tests;
