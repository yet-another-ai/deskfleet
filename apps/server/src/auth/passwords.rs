use super::*;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Email {
    pub email: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Verification {
    token: String,
    name: String,
    password: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Login {
    email: String,
    password: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Recovery {
    token: String,
    password: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Password {
    pub password: String,
}

fn policy(password: &str) -> Result<()> {
    let length = password.chars().count();
    if !(15..=128).contains(&length) || password.len() > 512 {
        return Err(ApiError::bad("Password must contain 15 to 128 characters."));
    }
    let simplified = password
        .to_lowercase()
        .replace([' ', '-', '_', '.', '!'], "");
    let common = [
        "passwordpassword",
        "password123456789",
        "123456789012345",
        "12345678901234567890",
        "qwertyuiopasdfghjkl",
        "iloveyouiloveyou",
        "letmeinletmeinletmein",
        "correcthorsebatterystaple",
    ];
    if common.contains(&simplified.as_str()) || password.chars().all(|c| password.starts_with(c)) {
        return Err(ApiError::bad(
            "Choose a password that is not commonly used.",
        ));
    }
    Ok(())
}
pub(super) async fn hash(state: &AppState, password: String) -> Result<String> {
    policy(&password)?;
    let permit = state
        .auth
        .hashing
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::internal())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let salt = SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes())
            .map_err(|_| ApiError::internal())?;
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|v| v.to_string())
            .map_err(|_| ApiError::internal())
    })
    .await
    .map_err(|_| ApiError::internal())?
}
async fn verify_password(
    state: &AppState,
    password: String,
    encoded: Option<String>,
) -> Result<bool> {
    if password.len() > 512 {
        return Ok(false);
    }
    let permit = state
        .auth
        .hashing
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::internal())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        match encoded {
            Some(encoded) => PasswordHash::new(&encoded).ok().is_some_and(|hash| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &hash)
                    .is_ok()
            }),
            None => {
                // Unknown addresses perform equivalent work without issuing an identity.
                if let Ok(salt) = SaltString::encode_b64(b"deskfleet-dummy-salt") {
                    let _ = Argon2::default().hash_password(password.as_bytes(), &salt);
                }
                false
            }
        }
    })
    .await
    .map_err(|_| ApiError::internal())
}
pub(super) async fn register(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Email>,
) -> Result<HttpResponse> {
    browser_mutation(&req, &state)?;
    let email = deskfleet_control_store::normalize_email(&body.email)?;
    limit(&req, &state, "mail", Some(&email)).await?;
    if !state.store.registration_enabled().await? {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "registration_disabled",
            "New account registration is disabled.",
        ));
    }
    if state.store.password_credentials(&email).await?.is_none() {
        let token = state
            .store
            .issue_identity_challenge("registration", None, &email, json!({}), 3_600_000)
            .await?;
        send_link(
            &state,
            &email,
            "Verify your deskfleet email",
            "verify",
            &token,
        )
        .await;
    }
    Ok(HttpResponse::Accepted().json(json!({})))
}
pub(super) async fn verify(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Verification>,
) -> Result<HttpResponse> {
    browser_mutation(&req, &state)?;
    limit(&req, &state, "verify", None).await?;
    let hash = hash(&state, body.password.clone()).await?;
    let user = state
        .store
        .verify_registration(&body.token, &body.name, &hash)
        .await?;
    session_response(&state, state.store.new_session(&user.id).await?)
}
pub(super) async fn login(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Login>,
) -> Result<HttpResponse> {
    browser_mutation(&req, &state)?;
    let email = deskfleet_control_store::normalize_email(&body.email)?;
    limit(&req, &state, "login", Some(&email)).await?;
    let record = state.store.password_credentials(&email).await?;
    if !verify_password(
        &state,
        body.password.clone(),
        record
            .as_ref()
            .and_then(|v| v["passwordHash"].as_str().map(str::to_owned)),
    )
    .await?
    {
        return Err(ApiError::unauthorized());
    }
    let record = record.ok_or_else(ApiError::unauthorized)?;
    session_response(
        &state,
        state
            .store
            .new_session_at_version(field(&record, "userId")?, record["version"].as_i64())
            .await?,
    )
}
pub(super) async fn recovery(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Email>,
) -> Result<HttpResponse> {
    browser_mutation(&req, &state)?;
    let email = deskfleet_control_store::normalize_email(&body.email)?;
    limit(&req, &state, "mail", Some(&email)).await?;
    if let Some(record) = state.store.password_credentials(&email).await? {
        let token = state
            .store
            .issue_identity_challenge(
                "recovery",
                Some(field(&record, "userId")?),
                &email,
                json!({"version":record["version"]}),
                3_600_000,
            )
            .await?;
        send_link(
            &state,
            &email,
            "Reset your deskfleet password",
            "recovery/complete",
            &token,
        )
        .await;
    }
    Ok(HttpResponse::Accepted().json(json!({})))
}
pub(super) async fn recover(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Recovery>,
) -> Result<HttpResponse> {
    browser_mutation(&req, &state)?;
    limit(&req, &state, "recovery", None).await?;
    let hash = hash(&state, body.password.clone()).await?;
    let (user_id, peers) = state.store.recover_password(&body.token, &hash).await?;
    state.hub.revoke(peers, "password_reset").await;
    state.hub.disconnect_user(&user_id).await;
    Ok(cleared(&state))
}
pub(super) async fn reauthenticate(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Password>,
) -> Result<HttpResponse> {
    let auth = user(&req, &state).await?;
    limit(&req, &state, "reauthenticate", Some(&auth.user.id)).await?;
    let record = state
        .store
        .password_credentials(
            auth.user
                .email
                .as_deref()
                .ok_or_else(ApiError::unauthorized)?,
        )
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    if !verify_password(
        &state,
        body.password.clone(),
        record["passwordHash"].as_str().map(str::to_owned),
    )
    .await?
    {
        return Err(ApiError::unauthorized());
    }
    state
        .store
        .refresh_authentication(
            &auth.id,
            record["version"].as_i64().ok_or_else(ApiError::internal)?,
        )
        .await?;
    Ok(HttpResponse::NoContent().finish())
}
pub(super) fn field<'a>(record: &'a Value, key: &str) -> Result<&'a str> {
    record[key].as_str().ok_or_else(ApiError::unauthorized)
}
pub(super) async fn send_link(
    state: &AppState,
    email: &str,
    subject: &str,
    path: &str,
    token: &str,
) {
    let body = format!(
        "{subject}\n\nOpen this link to continue:\n{}/auth/{path}#token={token}\n\nThis link expires in one hour and can be used once. If you did not request it, ignore this message.",
        state.auth.config.web_url
    );
    // Public response remains identical for absent users and delivery failures.
    // The persisted challenge and delivery diagnostic permit a fresh resend.
    if state.auth.mail.send(email, subject, &body).await.is_err() {
        tracing::warn!("authentication email delivery unsuccessful");
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn password_policy() {
        assert!(super::policy("A long memorable password 738").is_ok());
        for value in [
            "short",
            "passwordpassword",
            "123456789012345",
            "aaaaaaaaaaaaaaa",
        ] {
            assert!(super::policy(value).is_err());
        }
    }
}
