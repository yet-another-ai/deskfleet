//! Team, machine management, catalog and synchronized history endpoints.
use crate::{
    AppState, auth,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, web};
use deskfleet_control_store::policies::MachineAction;
use deskfleet_protocol::control::{ControlMessage, PeerActor};
use serde::Deserialize;
use serde_json::{Value, json};

pub fn actor(auth: &deskfleet_control_store::AuthSession) -> PeerActor {
    PeerActor {
        kind: "user".into(),
        user_id: auth.user.id.clone(),
        device_id: auth.device_id.clone(),
        source_machine: None,
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Name {
    name: String,
}
pub async fn teams(req: HttpRequest, s: web::Data<AppState>) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    Ok(web::Json(json!(s.store.teams(&a.user.id).await?)))
}
pub async fn team_usage(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    Ok(web::Json(s.store.team_usage(&a.user.id, &p).await?))
}
pub async fn create_team(
    req: HttpRequest,
    s: web::Data<AppState>,
    b: web::Json<Name>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    Ok(web::Json(json!(
        s.store.create_team(&a.user.id, &b.name).await?
    )))
}
pub async fn rename_team(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
    b: web::Json<Name>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    Ok(web::Json(json!(
        s.store.rename_team(&a.user.id, &p, &b.name).await?
    )))
}
pub async fn delete_team(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    s.store.delete_team(&a.user.id, &p).await?;
    Ok(web::Json(json!({})))
}
pub async fn members(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    Ok(web::Json(json!(s.store.members(&a.user.id, &p).await?)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Role {
    role: String,
}
pub async fn change_member(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<(String, String)>,
    b: web::Json<Role>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    s.store
        .change_member(&a.user.id, &p.0, &p.1, Some(&b.role))
        .await?;
    Ok(web::Json(json!({})))
}
pub async fn remove_member(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<(String, String)>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    s.store.change_member(&a.user.id, &p.0, &p.1, None).await?;
    let peers = s.store.revoke_member_peers(&p.0, &p.1).await?;
    s.hub.revoke(peers, "membership_removed").await?;
    Ok(web::Json(json!({})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Invite {
    email: String,
    role: String,
}
pub async fn invite(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
    b: web::Json<Invite>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    Ok(web::Json(
        s.store.invite(&a.user.id, &p, &b.email, &b.role).await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Token {
    token: String,
}
pub async fn accept_invite(
    req: HttpRequest,
    s: web::Data<AppState>,
    b: web::Json<Token>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    Ok(web::Json(json!(
        s.store.accept_invite(&a.user.id, &b.token).await?
    )))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Enrollment {
    name: String,
    origin_id: String,
    local_machine_id: String,
    #[serde(default)]
    capabilities: Value,
}
pub async fn enroll(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
    b: web::Json<Enrollment>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    let b = b.into_inner();
    let (m, t) = s
        .store
        .enroll(
            &a.user.id,
            &p,
            &b.name,
            &b.origin_id,
            &b.local_machine_id,
            b.capabilities,
        )
        .await?;
    if s.notify_team(
        &m.team_id,
        ControlMessage::MachinesChanged {
            team_id: m.team_id.clone(),
        },
    )
    .await
    .is_err()
    {
        // Enrollment committed; its plaintext credential is only returned here.
        tracing::warn!("machine enrolled but roster notification failed");
    }
    Ok(web::Json(json!({"machine":m,"token":t})))
}
pub async fn machines(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    let mut machines = s.store.machines(&a.user.id, &p).await?;
    for m in &mut machines {
        m.online = s.hub.online(&m.id).await;
    }
    Ok(web::Json(json!(machines)))
}
pub async fn rename_machine(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
    b: web::Json<Name>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    let mut m = s.store.rename_machine(&a.user.id, &p, &b.name).await?;
    m.online = s.hub.online(&m.id).await;
    // Open clients refetch the catalog, which carries the new name.
    s.notify_team(
        &m.team_id,
        ControlMessage::CatalogChanged {
            machine_id: m.id.clone(),
            session_id: None,
        },
    )
    .await?;
    s.notify_team(
        &m.team_id,
        ControlMessage::MachinesChanged {
            team_id: m.team_id.clone(),
        },
    )
    .await?;
    Ok(web::Json(json!(m)))
}
pub async fn remove_machine(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    let machine = s.store.machine(&p).await?;
    s.store.revoke_machine(&a.user.id, &p).await?;
    let peers = s.store.revoke_machine_peers(&p).await?;
    s.hub.revoke(peers, "machine_removed").await?;
    s.hub.disconnect_machine(&p).await?;
    s.notify_team(
        &machine.team_id,
        ControlMessage::MachinesChanged {
            team_id: machine.team_id.clone(),
        },
    )
    .await?;
    Ok(web::Json(json!({})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rpc {
    method: String,
    params: Value,
}
const MANAGEMENT: &[&str] = &[
    "catalogList",
    "workspaceCreate",
    "workspaceUpdate",
    "workspaceDelete",
    "directoryList",
    "providerList",
    "providerCreate",
    "providerUpdate",
    "providerRemove",
    "providerTest",
    "providerProbe",
    "providerInstall",
    "providerLogin",
    "capabilities",
    "systemStatus",
    "terminalList",
    "terminalDial",
    "terminalHangup",
    "_deskfleet/session/create",
    "_deskfleet/session/fork",
    "_deskfleet/session/archive",
    "_deskfleet/session/restore",
    "_deskfleet/session/rename",
    "_deskfleet/session/configuration",
    "_deskfleet/session/configure",
    "_deskfleet/agent/configuration",
    "_deskfleet/command/get",
    "scheduleList",
    "scheduleCreate",
    "scheduleUpdate",
    "scheduleDelete",
    "scheduleRun",
    "mcpServerList",
    "mcpServerCreate",
    "mcpServerUpdate",
    "mcpServerRemove",
];
pub async fn rpc(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
    b: web::Json<Rpc>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    s.store
        .authorize_machine(&a.user.id, &p, MachineAction::Manage)
        .await?;
    if !MANAGEMENT.contains(&b.method.as_str()) || !b.params.is_object() {
        return Err(ApiError::bad("unsupported management method"));
    }
    let b = b.into_inner();
    Ok(web::Json(
        s.hub
            .request(&p, &b.method, b.params, Some(actor(&a)))
            .await?,
    ))
}
pub async fn catalog(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    let m = s.store.authorized_machine(&a.user.id, &p).await?;
    let mut catalog = s.store.catalog(&p).await?;
    // The Team's name for the machine replaces the hostname its daemon reports.
    if let Some(snapshot) = catalog["snapshot"].as_object_mut() {
        snapshot.insert("machineName".into(), m.name.into());
    }
    Ok(web::Json(catalog))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    #[serde(default)]
    after: i64,
    #[serde(default = "page_size")]
    limit: u32,
    #[serde(default = "all_archive_states")]
    archive_state: String,
}
fn all_archive_states() -> String {
    "all".into()
}
pub async fn sessions(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<String>,
    q: web::Query<SessionPage>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    s.store.authorized_machine(&a.user.id, &p).await?;
    Ok(web::Json(
        s.store
            .sessions(&p, q.after, q.limit, &q.archive_state)
            .await?,
    ))
}
pub async fn snapshot(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<(String, String)>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    s.store.authorized_machine(&a.user.id, &p.0).await?;
    Ok(web::Json(s.store.session_snapshot(&p.0, &p.1).await?))
}
#[derive(Deserialize)]
pub struct Page {
    #[serde(default)]
    after: i64,
    #[serde(default = "page_size")]
    limit: u32,
}
fn page_size() -> u32 {
    200
}
pub async fn events(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<(String, String)>,
    q: web::Query<Page>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    s.store.authorized_machine(&a.user.id, &p.0).await?;
    Ok(web::Json(
        s.store.events(&p.0, &p.1, q.after, q.limit).await?,
    ))
}
pub async fn commands(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<(String, String)>,
    q: web::Query<Page>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    s.store.authorized_machine(&a.user.id, &p.0).await?;
    Ok(web::Json(
        s.store.commands(&p.0, &p.1, q.after, q.limit).await?,
    ))
}
pub async fn command(
    req: HttpRequest,
    s: web::Data<AppState>,
    p: web::Path<(String, String)>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    s.store.authorized_machine(&a.user.id, &p.0).await?;
    Ok(web::Json(s.store.command_by_operation(&p.0, &p.1).await?))
}
pub async fn daemon_me(req: HttpRequest, s: web::Data<AppState>) -> Result<web::Json<Value>> {
    let m = auth::machine(&req, &s).await?;
    Ok(web::Json(
        json!({"machine":m.machine,"serverId":s.config.public_url}),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegatedUser {
    user_id: String,
}

/// Recheck a durable user delegation against the enrolled machine's current Team.
/// Only the machine credential selects the target; the caller cannot choose another machine.
pub async fn authorize_delegation(
    req: HttpRequest,
    s: web::Data<AppState>,
    b: web::Json<DelegatedUser>,
) -> Result<web::Json<Value>> {
    let machine = auth::machine(&req, &s).await?;
    s.store
        .authorize_machine(&b.user_id, &machine.machine.id, MachineAction::Manage)
        .await?;
    Ok(web::Json(json!({"authorized": true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    snapshot: Value,
    capabilities: Option<Value>,
    #[serde(default)]
    providers: Value,
}
pub async fn sync_catalog(
    req: HttpRequest,
    s: web::Data<AppState>,
    b: web::Json<Catalog>,
) -> Result<web::Json<Value>> {
    let m = auth::machine(&req, &s).await?;
    if b.snapshot["machineId"].as_str() != Some(m.machine.local_machine_id.as_str()) {
        return Err(ApiError::bad("catalog belongs to another local machine"));
    }
    let b = b.into_inner();
    s.store
        .save_catalog(&m.machine.id, b.snapshot, safe_providers(&b.providers))
        .await?;
    if let Some(capabilities) = b.capabilities {
        s.store
            .set_machine_capabilities(&m.machine.id, capabilities)
            .await?;
    }
    s.store.machine_seen(&m.machine.id).await?;
    s.notify_team(
        &m.machine.team_id,
        ControlMessage::CatalogChanged {
            machine_id: m.machine.id,
            session_id: None,
        },
    )
    .await?;
    Ok(web::Json(json!({})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct History {
    session_id: String,
    snapshot: Value,
    events: Vec<Value>,
    #[serde(default)]
    commands: Vec<Value>,
}
pub async fn sync_history(
    req: HttpRequest,
    s: web::Data<AppState>,
    b: web::Json<History>,
) -> Result<web::Json<Value>> {
    let m = auth::machine(&req, &s).await?;
    let b = b.into_inner();
    let seq = s
        .store
        .sync_history(
            &m.machine.id,
            &b.session_id,
            b.snapshot,
            b.events,
            b.commands,
        )
        .await?;
    s.notify_team(
        &m.machine.team_id,
        ControlMessage::CatalogChanged {
            machine_id: m.machine.id,
            session_id: Some(b.session_id),
        },
    )
    .await?;
    Ok(web::Json(json!({"lastEventSeq":seq})))
}

fn safe_providers(value: &Value) -> Value {
    let providers = value["providers"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|p| {
                    let mut safe = json!({"id":p["id"],"template":p["template"],"name":p["name"]});
                    if let Some(icon) = p.get("icon") {
                        safe["icon"] = icon.clone();
                    }
                    safe
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let templates = value["templates"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|p| json!({"id":p["id"],"name":p["name"]}))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({"templates":templates,"providers":providers})
}
