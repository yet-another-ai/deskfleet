//! Route Agent MCP requests from an authenticated Machine or hosted Session to a Team registration.
use crate::{
    AppState, auth,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, web};
use deskfleet_control_store::policies::MachineAction;
use deskfleet_protocol::control::{PeerActor, RemoteMcpOperation, RemoteMcpRequest};
use serde_json::{Value, json};
use std::time::Duration;

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(test)]
mod tests;

pub async fn call(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<RemoteMcpRequest>,
) -> Result<web::Json<Value>> {
    let source = auth::machine(&req, &state).await?.machine;
    state
        .store
        .authorize_machine(&body.user_id, &source.id, MachineAction::Manage)
        .await?;
    let actor = PeerActor {
        kind: "user".into(),
        user_id: body.user_id.clone(),
        device_id: body.device_id.clone(),
        source_machine: Some(json!({"id": source.machine_id, "originId": source.origin_id})),
    };
    dispatch(
        &state,
        Source {
            team_id: &source.team_id,
            session_id: &body.session_id,
            machine_id: Some(&source.machine_id),
        },
        actor,
        body.operation,
        body.machine_id.as_deref(),
        &body.arguments,
    )
    .await
}

pub(crate) struct Source<'a> {
    pub team_id: &'a str,
    pub session_id: &'a str,
    /// Hosted Super Agent Sessions have no source Machine.
    pub machine_id: Option<&'a str>,
}

pub(crate) async fn dispatch(
    state: &web::Data<AppState>,
    source: Source<'_>,
    actor: PeerActor,
    operation: RemoteMcpOperation,
    machine_id: Option<&str>,
    arguments: &Value,
) -> Result<web::Json<Value>> {
    if actor.device_id.is_empty() || source.session_id.is_empty() || !arguments.is_object() {
        return Err(ApiError::bad("invalid Agent MCP delegation"));
    }
    let source_context = match source.machine_id {
        Some(id) => {
            json!({"teamId": source.team_id, "machineId": id, "sessionId": source.session_id})
        }
        None => {
            json!({"teamId": source.team_id, "kind": "superAgent", "sessionId": source.session_id})
        }
    };
    if operation == RemoteMcpOperation::Machines {
        if machine_id.is_some() || arguments != &json!({}) {
            return Err(ApiError::bad(
                "machine discovery takes no target or arguments",
            ));
        }
        let machines = state.store.machines(&actor.user_id, source.team_id).await?;
        let online = state
            .hub
            .online_machines(
                &machines
                    .iter()
                    .map(|machine| machine.id.clone())
                    .collect::<Vec<_>>(),
            )
            .await;
        // Ask each target for current host consent. Offline machines and denied targets
        // expose no cached catalog or conversation data to an Agent.
        let mut pending = tokio::task::JoinSet::new();
        for mut machine in machines.into_iter().filter(|machine| {
            online.contains(&machine.id) && Some(machine.machine_id.as_str()) != source.machine_id
        }) {
            machine.online = true;
            let state = state.clone();
            let actor = actor.clone();
            let source_context = source_context.clone();
            pending.spawn(async move {
                let access = state
                    .hub
                    .request_with_timeout(
                        &machine.id,
                        "remoteMcpDiscover",
                        source_context,
                        Some(actor),
                        DISCOVERY_TIMEOUT,
                    )
                    .await
                    .ok()?;
                if access["allowRead"] != true
                    && access["allowOperate"] != true
                    && access["allowSessions"] != true
                    && access["allowWorkspaces"] != true
                {
                    return None;
                }
                Some(json!({"machine": machine.into_public(), "access": access}))
            });
        }
        let mut available = Vec::new();
        while let Some(result) = pending.join_next().await {
            if let Some(machine) = result.map_err(|_| ApiError::internal())? {
                available.push(machine);
            }
        }
        available.sort_by(|a, b| {
            a["machine"]["id"]
                .as_str()
                .cmp(&b["machine"]["id"].as_str())
        });
        return Ok(web::Json(
            json!({"teamId": source.team_id, "machines": available}),
        ));
    }
    let machine_id = machine_id
        .filter(|id| !id.is_empty())
        .ok_or_else(|| ApiError::bad("a target machine is required"))?;
    if Some(machine_id) == source.machine_id {
        return Err(ApiError::bad("select another machine"));
    }
    let action = if matches!(
        operation,
        RemoteMcpOperation::SessionCreate
            | RemoteMcpOperation::SessionSend
            | RemoteMcpOperation::WorkspaceCreate
            | RemoteMcpOperation::McpCall
            | RemoteMcpOperation::FilesWrite
    ) {
        MachineAction::Manage
    } else {
        MachineAction::Read
    };
    let target = state
        .store
        .authorize_registration(&actor.user_id, source.team_id, machine_id, action)
        .await?;
    let result = state
        .hub
        .request(
            &target.id,
            "remoteMcp",
            json!({
                "source": source_context, "operation": operation, "arguments": arguments,
            }),
            Some(actor),
        )
        .await?;
    Ok(web::Json(result))
}
