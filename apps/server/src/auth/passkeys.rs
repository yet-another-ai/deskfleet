//! WebAuthn ceremonies remain server-side, purpose- and session-bound.
use super::passwords::{Email, field};
use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Registration {
    ceremony_id: String,
    credential: RegisterPublicKeyCredential,
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Authentication {
    ceremony_id: String,
    credential: PublicKeyCredential,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Name {
    name: String,
}
fn encoded<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| ApiError::internal())
}
fn decoded<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| ApiError::unauthorized())
}
async fn keys(state: &AppState, user_id: &str) -> Result<Vec<Passkey>> {
    state
        .store
        .passkeys(user_id)
        .await?
        .into_iter()
        .map(|v| decoded(v["record"].clone()))
        .collect()
}
async fn account_version(state: &AppState, email: &str) -> Result<Value> {
    state
        .store
        .password_credentials(email)
        .await?
        .ok_or_else(ApiError::unauthorized)
}
pub(super) async fn list(req: HttpRequest, state: web::Data<AppState>) -> Result<web::Json<Value>> {
    let auth = user(&req, &state).await?;
    let values = state
        .store
        .passkeys(&auth.user.id)
        .await?
        .into_iter()
        .map(|v| json!({"id":v["id"],"name":v["name"],"createdAt":v["createdAt"]}))
        .collect::<Vec<_>>();
    Ok(web::Json(json!(values)))
}
pub(super) async fn registration_options(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<web::Json<Value>> {
    let auth = recent(&req, &state).await?;
    let existing = keys(&state, &auth.user.id).await?;
    let id = uuid::Uuid::parse_str(&auth.user.id).map_err(|_| ApiError::internal())?;
    let email = auth
        .user
        .email
        .as_deref()
        .ok_or_else(ApiError::unauthorized)?;
    let version = account_version(&state, email).await?;
    let (options, ceremony) = state
        .auth
        .webauthn
        .start_passkey_registration(
            id,
            email,
            &auth.user.name,
            Some(existing.iter().map(|key| key.cred_id().clone()).collect()),
        )
        .map_err(|_| ApiError::bad("Passkey registration is unavailable"))?;
    let token = state
        .store
        .issue_identity_challenge(
            "passkey_registration",
            Some(&auth.user.id),
            email,
            json!({"state":encoded(ceremony)?,"sessionId":auth.id,"version":version["version"]}),
            300_000,
        )
        .await?;
    let mut public_key = encoded(options)?["publicKey"].clone();
    // Anonymous login must not disclose account-specific credential IDs. Ask
    // browsers to create discoverable credentials for that login ceremony.
    public_key["authenticatorSelection"]["residentKey"] = json!("required");
    public_key["authenticatorSelection"]["requireResidentKey"] = json!(true);
    Ok(web::Json(
        json!({"ceremonyId":token,"publicKey":public_key}),
    ))
}
pub(super) async fn register(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Registration>,
) -> Result<HttpResponse> {
    let auth = recent(&req, &state).await?;
    let saved = state
        .store
        .consume_identity_challenge(&body.ceremony_id, "passkey_registration")
        .await?;
    if saved["userId"] != auth.user.id || saved["record"]["sessionId"] != auth.id {
        return Err(ApiError::unauthorized());
    }
    let version = account_version(
        &state,
        auth.user
            .email
            .as_deref()
            .ok_or_else(ApiError::unauthorized)?,
    )
    .await?;
    if saved["record"]["version"] != version["version"] {
        return Err(ApiError::unauthorized());
    }
    let ceremony: PasskeyRegistration = decoded(saved["record"]["state"].clone())?;
    let key = state
        .auth
        .webauthn
        .finish_passkey_registration(&body.credential, &ceremony)
        .map_err(|_| ApiError::unauthorized())?;
    let credential = encoded(key.cred_id())?;
    state
        .store
        .save_passkey(
            &auth.user.id,
            credential.as_str().ok_or_else(ApiError::internal)?,
            encoded(&key)?,
            &body.name,
            &auth.id,
        )
        .await?;
    Ok(HttpResponse::Created().json(json!({})))
}
async fn options(
    state: &AppState,
    email: &str,
    purpose: &str,
    session_id: Option<&str>,
) -> Result<web::Json<Value>> {
    let record = account_version(state, email).await?;
    let user_id = field(&record, "userId")?;
    let (options, ceremony) = state
        .auth
        .webauthn
        .start_passkey_authentication(&keys(state, user_id).await?)
        .map_err(|_| ApiError::unauthorized())?;
    let token = state
        .store
        .issue_identity_challenge(
            purpose,
            Some(user_id),
            email,
            json!({"state":encoded(ceremony)?,"sessionId":session_id,"version":record["version"]}),
            300_000,
        )
        .await?;
    Ok(web::Json(
        json!({"ceremonyId":token,"publicKey":encoded(options)?["publicKey"]}),
    ))
}
pub(super) async fn login_options(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Email>,
) -> Result<web::Json<Value>> {
    browser_mutation(&req, &state)?;
    let email = deskfleet_control_store::normalize_email(&body.email)?;
    limit(&req, &state, "login", Some(&email)).await?;
    // Bind the ceremony to this email and its current credential version, but
    // never expose whether it belongs to an active account or has any keys.
    let record = state.store.password_credentials(&email).await?;
    let user_id = record.as_ref().and_then(|record| record["userId"].as_str());
    let version = record.as_ref().map(|record| &record["version"]);
    let (options, ceremony) = state
        .auth
        .webauthn
        .start_discoverable_authentication()
        .map_err(|_| ApiError::internal())?;
    let token = state
        .store
        .issue_identity_challenge(
            "passkey_login",
            user_id,
            &email,
            json!({"state":encoded(ceremony)?,"sessionId":null,"version":version}),
            300_000,
        )
        .await?;
    Ok(web::Json(
        json!({"ceremonyId":token,"publicKey":encoded(options)?["publicKey"]}),
    ))
}
pub(super) async fn reauthentication_options(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<web::Json<Value>> {
    let auth = user(&req, &state).await?;
    limit(&req, &state, "reauthenticate", Some(&auth.user.id)).await?;
    options(
        &state,
        auth.user
            .email
            .as_deref()
            .ok_or_else(ApiError::unauthorized)?,
        "passkey_reauthentication",
        Some(&auth.id),
    )
    .await
}
async fn finish(
    state: &AppState,
    body: &Authentication,
    purpose: &str,
    session_id: Option<&str>,
) -> Result<(String, i64)> {
    let saved = state
        .store
        .consume_identity_challenge(&body.ceremony_id, purpose)
        .await?;
    if saved["record"]["sessionId"].as_str() != session_id {
        return Err(ApiError::unauthorized());
    }
    let user_id = field(&saved, "userId")?;
    let result = if purpose == "passkey_login" {
        let (credential_user, _) = state
            .auth
            .webauthn
            .identify_discoverable_authentication(&body.credential)
            .map_err(|_| ApiError::unauthorized())?;
        if credential_user.to_string() != user_id {
            return Err(ApiError::unauthorized());
        }
        let ceremony: DiscoverableAuthentication = decoded(saved["record"]["state"].clone())?;
        let credentials: Vec<DiscoverableKey> = keys(state, user_id)
            .await?
            .into_iter()
            .map(Into::into)
            .collect();
        state.auth.webauthn.finish_discoverable_authentication(
            &body.credential,
            ceremony,
            &credentials,
        )
    } else {
        let ceremony: PasskeyAuthentication = decoded(saved["record"]["state"].clone())?;
        state
            .auth
            .webauthn
            .finish_passkey_authentication(&body.credential, &ceremony)
    }
    .map_err(|_| ApiError::unauthorized())?;
    let mut found = false;
    for row in state.store.passkeys(user_id).await? {
        let mut key: Passkey = decoded(row["record"].clone())?;
        if key.cred_id() == result.cred_id() {
            found = true;
            key.update_credential(&result);
            state
                .store
                .update_passkey_record(
                    user_id,
                    field(&row, "id")?,
                    encoded(key)?,
                    row["record"].clone(),
                )
                .await?;
        }
    }
    if !found {
        return Err(ApiError::unauthorized());
    }
    Ok((
        user_id.to_owned(),
        saved["record"]["version"]
            .as_i64()
            .ok_or_else(ApiError::unauthorized)?,
    ))
}
pub(super) async fn login(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Authentication>,
) -> Result<HttpResponse> {
    browser_mutation(&req, &state)?;
    limit(&req, &state, "passkey_finish", None).await?;
    let (user_id, version) = finish(&state, &body, "passkey_login", None).await?;
    session_response(
        &state,
        state
            .store
            .new_session_at_version(&user_id, Some(version))
            .await?,
    )
}
pub(super) async fn reauthenticate(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Authentication>,
) -> Result<HttpResponse> {
    let auth = user(&req, &state).await?;
    let (user_id, version) =
        finish(&state, &body, "passkey_reauthentication", Some(&auth.id)).await?;
    if user_id != auth.user.id {
        return Err(ApiError::unauthorized());
    }
    state
        .store
        .refresh_authentication(&auth.id, version)
        .await?;
    Ok(HttpResponse::NoContent().finish())
}
pub(super) async fn rename(
    req: HttpRequest,
    state: web::Data<AppState>,
    id: web::Path<String>,
    body: web::Json<Name>,
) -> Result<HttpResponse> {
    let auth = recent(&req, &state).await?;
    state
        .store
        .rename_passkey(&auth.user.id, &id, &body.name)
        .await?;
    Ok(HttpResponse::NoContent().finish())
}
pub(super) async fn remove(
    req: HttpRequest,
    state: web::Data<AppState>,
    id: web::Path<String>,
) -> Result<HttpResponse> {
    let auth = recent(&req, &state).await?;
    state
        .store
        .remove_passkey(&auth.user.id, &id, &auth.id)
        .await?;
    Ok(HttpResponse::NoContent().finish())
}
