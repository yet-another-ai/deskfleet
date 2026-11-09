//! Machine credentials fix the source Team; only this route can relay Agent MCP operations.
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
    if body.device_id.is_empty() || body.session_id.is_empty() || !body.arguments.is_object() {
        return Err(ApiError::bad("invalid Agent MCP delegation"));
    }
    let actor = PeerActor {
        kind: "user".into(),
        user_id: body.user_id.clone(),
        device_id: body.device_id.clone(),
        source_machine: Some(json!({"id": source.machine_id, "originId": source.origin_id})),
    };
    let source_context = json!({"teamId": source.team_id, "machineId": source.machine_id, "sessionId": body.session_id});
    if body.operation == RemoteMcpOperation::Machines {
        if body.machine_id.is_some() || body.arguments != json!({}) {
            return Err(ApiError::bad(
                "machine discovery takes no target or arguments",
            ));
        }
        let machines = state.store.machines(&body.user_id, &source.team_id).await?;
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
            online.contains(&machine.id) && machine.machine_id != source.machine_id
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
    let machine_id = body
        .machine_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| ApiError::bad("a target machine is required"))?;
    if machine_id == source.machine_id {
        return Err(ApiError::bad("select another machine"));
    }
    let action = if matches!(
        body.operation,
        RemoteMcpOperation::SessionCreate
            | RemoteMcpOperation::SessionSend
            | RemoteMcpOperation::McpCall
            | RemoteMcpOperation::FilesWrite
    ) {
        MachineAction::Manage
    } else {
        MachineAction::Read
    };
    let target = state
        .store
        .authorize_registration(&body.user_id, &source.team_id, machine_id, action)
        .await?;
    let result = state
        .hub
        .request(
            &target.id,
            "remoteMcp",
            json!({
                "source": source_context, "operation": body.operation, "arguments": body.arguments,
            }),
            Some(actor),
        )
        .await?;
    Ok(web::Json(result))
}
