//! Stateless MCP Streamable HTTP endpoint for Eve's private DeskFleet connection.
use super::{
    AppState, HttpRequest, HttpResponse, Result, TeamAction, require_rollout, require_session,
    rollout_for_member, runtime, web,
};
use crate::{api, error::ApiError, remote_mcp};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use deskfleet_protocol::control::RemoteMcpOperation;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::sync::LazyLock;

// Keep the cloud and stdio tool names, descriptions and schemas in sync.
static TOOLS: LazyLock<Vec<Tool>> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../packages/mcp/src/remote-tools.json"
    ))
    .expect("valid bundled DeskFleet MCP tool catalog")
});

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Tool {
    name: String,
    description: String,
    input_schema: Value,
    #[serde(skip_serializing)]
    operation: RemoteMcpOperation,
}

#[derive(Deserialize)]
struct ForwardedPrincipal {
    current: Principal,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Principal {
    authenticator: String,
    principal_id: String,
    principal_type: String,
    attributes: Delegation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Delegation {
    login_id: String,
    team_id: String,
    session_id: String,
}

fn current_caller(req: &HttpRequest) -> Result<Principal> {
    req.headers()
        .get("eve-forwarded-principal")
        .and_then(|v| URL_SAFE_NO_PAD.decode(v.as_bytes()).ok())
        .and_then(|bytes| serde_json::from_slice::<ForwardedPrincipal>(&bytes).ok())
        .map(|p| p.current)
        .filter(|p| p.authenticator == "deskfleet" && p.principal_type == "user")
        .ok_or_else(ApiError::unauthorized)
}

#[derive(Deserialize)]
struct Call {
    name: String,
    #[serde(default)]
    arguments: Map<String, Value>,
}

fn rpc_error(id: &Value, code: i32, message: &str) -> HttpResponse {
    HttpResponse::Ok()
        .json(json!({"jsonrpc":"2.0", "id":id, "error":{"code":code, "message":message}}))
}

pub(super) async fn handle(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Value>,
) -> Result<HttpResponse> {
    runtime(&state)?.authenticate_service(&req)?;
    let id = &body["id"];
    let Some(method) = body["method"].as_str().filter(|_| body["jsonrpc"] == "2.0") else {
        return Ok(rpc_error(&Value::Null, -32600, "Invalid Request"));
    };
    if body.get("id").is_none() && method.starts_with("notifications/") {
        return Ok(HttpResponse::Accepted().finish());
    }
    if !id.is_string() && !id.is_number() {
        return Ok(rpc_error(&Value::Null, -32600, "Invalid request ID"));
    }
    let result = match method {
        "initialize" => {
            let version = body["params"]["protocolVersion"]
                .as_str()
                .filter(|v| matches!(*v, "2025-03-26" | "2025-06-18"))
                .unwrap_or("2025-11-25");
            json!({"protocolVersion":version,"capabilities":{"tools":{}},
                "serverInfo":{"name":"deskfleet","version":env!("CARGO_PKG_VERSION")}})
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools":&*TOOLS}),
        "tools/call" => return call_tool(&state, current_caller(&req)?, id, &body["params"]).await,
        _ => return Ok(rpc_error(id, -32601, "Method not found")),
    };
    Ok(HttpResponse::Ok().json(json!({"jsonrpc":"2.0","id":id,"result":result})))
}

async fn call_tool(
    state: &web::Data<AppState>,
    caller: Principal,
    id: &Value,
    params: &Value,
) -> Result<HttpResponse> {
    let scope = caller.attributes;
    let login = state.store.delegated_login(&scope.login_id).await?;
    if login.user.id != caller.principal_id {
        return Err(ApiError::unauthorized());
    }
    require_rollout(
        rollout_for_member(&login, state, &scope.team_id, TeamAction::UseSuperAgent).await?,
    )?;
    require_session(state, &scope.team_id, &scope.session_id).await?;

    let Ok(mut call) = Call::deserialize(params) else {
        return Ok(rpc_error(id, -32602, "Invalid tool parameters"));
    };
    let Some(tool) = TOOLS.iter().find(|tool| tool.name == call.name) else {
        return Ok(rpc_error(id, -32602, "Unknown DeskFleet tool"));
    };
    let target = match call.arguments.remove("machineId") {
        Some(Value::String(machine_id)) => Some(machine_id),
        None => None,
        _ => return Ok(rpc_error(id, -32602, "Invalid machineId")),
    };
    let source = remote_mcp::Source {
        team_id: &scope.team_id,
        session_id: &scope.session_id,
        machine_id: None,
        super_agent: true,
    };
    let result = match remote_mcp::dispatch(
        state,
        source,
        api::actor(&login),
        tool.operation,
        target.as_deref(),
        &Value::Object(call.arguments),
    )
    .await
    {
        Ok(result) if tool.operation == RemoteMcpOperation::McpCall => result.into_inner(),
        Ok(result) => json!({"content":[{"type":"text","text":result.into_inner().to_string()}]}),
        Err(error) => json!({"isError":true,"content":[{"type":"text","text":error.message}]}),
    };
    Ok(HttpResponse::Ok().json(json!({"jsonrpc":"2.0","id":id,"result":result})))
}
