use super::passwords::{Email, Password};
use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Token {
    token: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Registration {
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Disabled {
    disabled: bool,
}

pub(super) async fn password(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Password>,
) -> Result<HttpResponse> {
    let auth = recent(&req, &state).await?;
    let hash = passwords::hash(&state, body.password.clone()).await?;
    let peers = state
        .store
        .change_password(&auth.user.id, &hash, &auth.id)
        .await?;
    state.hub.revoke(peers, "password_changed").await?;
    state.hub.disconnect_user(&auth.user.id).await?;
    Ok(cleared(&state))
}
pub(super) async fn email(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Email>,
) -> Result<HttpResponse> {
    let auth = recent(&req, &state).await?;
    let email = deskfleet_control_store::normalize_email(&body.email)?;
    limit(&req, &state, "mail", Some(&email)).await?;
    let credentials = state
        .store
        .password_credentials(
            auth.user
                .email
                .as_deref()
                .ok_or_else(ApiError::unauthorized)?,
        )
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    let token = state
        .store
        .issue_identity_challenge(
            "email",
            Some(&auth.user.id),
            &email,
            json!({"version":credentials["version"]}),
            3_600_000,
        )
        .await?;
    passwords::send_link(
        &state,
        &email,
        "Verify your new DeskFleet email",
        "email/verify",
        &token,
    )
    .await;
    Ok(HttpResponse::Accepted().json(json!({})))
}
pub(super) async fn verify_email(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Token>,
) -> Result<HttpResponse> {
    let auth = user(&req, &state).await?;
    let (previous, peers) = state
        .store
        .verify_email_change(&body.token, &auth.user.id)
        .await?;
    state.hub.revoke(peers, "email_changed").await?;
    state.hub.disconnect_user(&auth.user.id).await?;
    if state.auth.mail.send(&previous,"Your DeskFleet email changed","Your account email address was changed. If you did not authorize this, contact the installation operator immediately.").await.is_err(){tracing::warn!("account email change notification delivery failed");}
    Ok(cleared(&state))
}
pub(super) async fn sessions(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<web::Json<Value>> {
    let auth = user(&req, &state).await?;
    Ok(web::Json(json!(
        state.store.login_sessions(&auth.user.id, &auth.id).await?
    )))
}
pub(super) async fn revoke_session(
    req: HttpRequest,
    state: web::Data<AppState>,
    id: web::Path<String>,
) -> Result<HttpResponse> {
    let auth = user(&req, &state).await?;
    let owned = state
        .store
        .login_sessions(&auth.user.id, &auth.id)
        .await?
        .iter()
        .any(|s| s["id"] == *id);
    if !owned {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "Login session not found.",
        ));
    }
    let peers = state
        .store
        .revoke_user_sessions(&auth.user.id, Some(&id))
        .await?;
    state.hub.revoke(peers, "session_revoked").await?;
    state.hub.disconnect_login(&id).await?;
    if *id == auth.id {
        Ok(cleared(&state))
    } else {
        Ok(HttpResponse::NoContent().finish())
    }
}
pub(super) async fn revoke_all(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<HttpResponse> {
    let auth = recent(&req, &state).await?;
    let peers = state
        .store
        .revoke_user_sessions(&auth.user.id, None)
        .await?;
    state.hub.revoke(peers, "sessions_revoked").await?;
    state.hub.disconnect_user(&auth.user.id).await?;
    Ok(cleared(&state))
}
pub(super) async fn registration(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Registration>,
) -> Result<HttpResponse> {
    let auth = recent(&req, &state).await?;
    state
        .store
        .set_registration_enabled(&auth.user.id, body.enabled)
        .await?;
    Ok(HttpResponse::NoContent().finish())
}
pub(super) async fn disabled(
    req: HttpRequest,
    state: web::Data<AppState>,
    id: web::Path<String>,
    body: web::Json<Disabled>,
) -> Result<HttpResponse> {
    let auth = recent(&req, &state).await?;
    let peers = state
        .store
        .disable_account(&auth.user.id, &id, body.disabled)
        .await?;
    state.hub.revoke(peers, "account_disabled").await?;
    state.hub.disconnect_user(&id).await?;
    Ok(HttpResponse::NoContent().finish())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Search {
    #[serde(default)]
    query: String,
}
pub(super) async fn users(
    req: HttpRequest,
    state: web::Data<AppState>,
    query: web::Query<Search>,
) -> Result<web::Json<Value>> {
    let auth = user(&req, &state).await?;
    Ok(web::Json(json!(
        state
            .store
            .find_accounts(&auth.user.id, &query.query)
            .await?
    )))
}
