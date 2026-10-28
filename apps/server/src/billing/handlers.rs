use crate::{AppState, auth, error::Result};
use actix_web::{HttpRequest, web};
use serde::Deserialize;
use serde_json::{Value, json};

pub fn configure(config: &mut web::ServiceConfig) {
    config
        .route("/teams/{teamId}/billing", web::get().to(summary))
        .route("/teams/{teamId}/billing/checkout", web::post().to(checkout))
        .route("/teams/{teamId}/billing/portal", web::post().to(portal))
        .route(
            "/billing/stripe/webhook",
            web::post().to(super::webhook::receive),
        )
        .route("/admin/teams", web::get().to(admin_teams))
        .route(
            "/admin/teams/{teamId}/enterprise",
            web::put().to(enterprise),
        )
        .route("/daemon/entitlements", web::get().to(entitlements))
        .service(
            web::resource("/daemon/session-admissions")
                .route(web::post().to(reserve))
                .route(web::get().to(admissions)),
        )
        .route(
            "/daemon/session-admissions/release",
            web::post().to(release),
        )
        .route(
            "/daemon/session-admissions/{admissionId}/confirm",
            web::post().to(confirm),
        )
        .route(
            "/daemon/session-admissions/{admissionId}/cancel",
            web::post().to(cancel),
        );
}
async fn summary(
    req: HttpRequest,
    s: web::Data<AppState>,
    team: web::Path<String>,
) -> Result<web::Json<Value>> {
    let user = auth::user(&req, &s).await?;
    let role = s.store.team_role(&user.user.id, &team).await?;
    let mut summary = s.store.billing_summary(&team).await?;
    summary["paymentsAvailable"] = json!(s.billing.enabled());
    summary["canManageBilling"] = json!(role == "admin");
    summary["enterpriseContactEmail"] = json!(s.billing.enterprise_contact_email());
    Ok(web::Json(summary))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checkout {
    plan: String,
    request_id: String,
    #[serde(default = "default_interval")]
    interval: String,
}
fn default_interval() -> String {
    "month".into()
}
async fn checkout(
    req: HttpRequest,
    s: web::Data<AppState>,
    team: web::Path<String>,
    body: web::Json<Checkout>,
) -> Result<web::Json<Value>> {
    let user = auth::user(&req, &s).await?;
    s.store.require_admin(&user.user.id, &team).await?;
    Ok(web::Json(
        json!({"url":s.billing.checkout(&s.store,&team,&body.plan,&body.interval,&body.request_id).await?}),
    ))
}
async fn portal(
    req: HttpRequest,
    s: web::Data<AppState>,
    team: web::Path<String>,
) -> Result<web::Json<Value>> {
    let user = auth::user(&req, &s).await?;
    s.store.require_admin(&user.user.id, &team).await?;
    Ok(web::Json(
        json!({"url":s.billing.portal(&s.store,&team).await?}),
    ))
}
#[derive(Deserialize)]
struct AdminTeamsQuery {
    cursor: Option<String>,
    limit: Option<usize>,
}
async fn admin_teams(
    req: HttpRequest,
    s: web::Data<AppState>,
    query: web::Query<AdminTeamsQuery>,
) -> Result<web::Json<Value>> {
    let user = auth::user(&req, &s).await?;
    Ok(web::Json(json!(
        s.store
            .admin_billing_teams(
                &user.user.id,
                query.cursor.as_deref(),
                query.limit.unwrap_or(100)
            )
            .await?
    )))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Enterprise {
    enabled: bool,
}
async fn enterprise(
    req: HttpRequest,
    s: web::Data<AppState>,
    team: web::Path<String>,
    body: web::Json<Enterprise>,
) -> Result<web::Json<Value>> {
    let user = auth::recent(&req, &s).await?;
    s.store
        .set_enterprise(&user.user.id, &team, body.enabled)
        .await?;
    Ok(web::Json(json!({"enterpriseOverride":body.enabled})))
}
async fn entitlements(req: HttpRequest, s: web::Data<AppState>) -> Result<web::Json<Value>> {
    let machine = auth::machine(&req, &s).await?;
    Ok(web::Json(
        s.store.team_entitlements(&machine.machine.team_id).await?,
    ))
}
async fn admissions(req: HttpRequest, s: web::Data<AppState>) -> Result<web::Json<Value>> {
    let machine = auth::machine(&req, &s).await?;
    Ok(web::Json(
        json!({"admissions":s.store.session_admissions(&machine.machine.id).await?}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reserve {
    operation_id: String,
    kind: String,
    session_id: Option<String>,
}
async fn reserve(
    req: HttpRequest,
    s: web::Data<AppState>,
    body: web::Json<Reserve>,
) -> Result<web::Json<Value>> {
    let machine = auth::machine(&req, &s).await?;
    Ok(web::Json(
        s.store
            .reserve_session(
                &machine.machine.id,
                &body.operation_id,
                &body.kind,
                body.session_id.as_deref(),
            )
            .await?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Confirm {
    generation: String,
    session_id: String,
}
async fn confirm(
    req: HttpRequest,
    s: web::Data<AppState>,
    id: web::Path<String>,
    body: web::Json<Confirm>,
) -> Result<web::Json<Value>> {
    let machine = auth::machine(&req, &s).await?;
    Ok(web::Json(
        s.store
            .confirm_session_admission(&machine.machine.id, &id, &body.generation, &body.session_id)
            .await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Generation {
    generation: String,
}
async fn cancel(
    req: HttpRequest,
    s: web::Data<AppState>,
    id: web::Path<String>,
    body: web::Json<Generation>,
) -> Result<web::Json<Value>> {
    let machine = auth::machine(&req, &s).await?;
    s.store
        .cancel_session_admission(&machine.machine.id, &id, &body.generation)
        .await?;
    Ok(web::Json(json!({})))
}
async fn release(
    req: HttpRequest,
    s: web::Data<AppState>,
    body: web::Json<Confirm>,
) -> Result<web::Json<Value>> {
    let machine = auth::machine(&req, &s).await?;
    s.store
        .release_session_admission(&machine.machine.id, &body.session_id, &body.generation)
        .await?;
    Ok(web::Json(json!({})))
}
