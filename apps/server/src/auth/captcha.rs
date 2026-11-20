//! Self-hosted ALTCHA challenges use the same expiring store as WebAuthn ceremonies.
use super::{browser_mutation, limit};
use crate::{
    AppState,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use altcha::{CreateChallengeOptions, Payload, VerifySolutionOptions, create_challenge};
use base64::{Engine, engine::general_purpose::STANDARD};
use deskfleet_control_store::{Error as StoreError, now_ms, secret};
use serde::{Deserialize, Serialize};
use serde_json::json;

const LIFETIME_SECONDS: i64 = 300;
const MAX_PAYLOAD_BYTES: usize = 4096;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Action {
    Login,
    Register,
    Passkey,
    Github,
    Google,
}

impl Action {
    fn purpose(self) -> &'static str {
        match self {
            Self::Login => "captcha_login",
            Self::Register => "captcha_register",
            Self::Passkey => "captcha_passkey",
            Self::Github => "captcha_github",
            Self::Google => "captcha_google",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ChallengeRequest {
    action: Action,
}

#[derive(Deserialize, Serialize)]
struct SigningKeys {
    challenge: String,
    solution: String,
}

pub(super) async fn challenge(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<ChallengeRequest>,
) -> Result<HttpResponse> {
    browser_mutation(&req, &state)?;
    if !state.store.captcha_enabled().await? {
        return Ok(HttpResponse::NoContent()
            .insert_header(("Cache-Control", "no-store"))
            .finish());
    }
    limit(&req, &state, "captcha_challenge", None).await?;

    // Short-lived private keys travel through the shared store so either step
    // can reach any server replica.
    let keys = SigningKeys {
        challenge: secret(),
        solution: secret(),
    };
    let expires_at = now_ms() / 1000 + LIFETIME_SECONDS;
    let token = state
        .store
        .issue_identity_challenge(
            body.action.purpose(),
            None,
            "",
            serde_json::to_value(&keys).map_err(|_| ApiError::internal())?,
            LIFETIME_SECONDS * 1000,
        )
        .await?;
    let options = CreateChallengeOptions {
        algorithm: "PBKDF2/SHA-256".into(),
        cost: 5000,
        counter: Some(rand::random_range(1024..=2048)),
        data: Some([("token".into(), json!(token))].into()),
        expires_at: Some(expires_at),
        hmac_signature_secret: Some(keys.challenge),
        hmac_key_signature_secret: Some(keys.solution),
        ..Default::default()
    };
    let challenge = web::block(move || create_challenge(options))
        .await
        .map_err(|_| ApiError::internal())?
        .map_err(|_| ApiError::internal())?;
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(challenge))
}

pub(super) async fn require(state: &AppState, action: Action, payload: Option<&str>) -> Result<()> {
    if !state.store.captcha_enabled().await? {
        return Ok(());
    }
    let payload = payload.ok_or_else(|| {
        ApiError::new(
            StatusCode::FORBIDDEN,
            "captcha_required",
            "Complete the verification before trying again.",
        )
    })?;
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(invalid());
    }
    let decoded = STANDARD.decode(payload).map_err(|_| invalid())?;
    let payload: Payload = serde_json::from_slice(&decoded).map_err(|_| invalid())?;
    let token = payload
        .challenge
        .parameters
        .data
        .as_ref()
        .and_then(|data| data.get("token"))
        .and_then(|value| value.as_str())
        .ok_or_else(invalid)?;
    let challenge = state
        .store
        .read_identity_challenge(token, action.purpose())
        .await
        .map_err(challenge_error)?;
    let keys: SigningKeys =
        serde_json::from_value(challenge["record"].clone()).map_err(|_| ApiError::internal())?;
    let verification = altcha::verify_solution(VerifySolutionOptions {
        hmac_key_signature_secret: Some(keys.solution),
        ..VerifySolutionOptions::new(&payload.challenge, &payload.solution, &keys.challenge)
    })
    .map_err(|_| invalid())?;
    if !verification.verified {
        return Err(invalid());
    }
    // A proof can reach the verification step concurrently, but only one
    // request may consume it and proceed with the protected operation.
    state
        .store
        .consume_identity_challenge(token, action.purpose())
        .await
        .map_err(challenge_error)?;
    Ok(())
}

fn challenge_error(error: StoreError) -> ApiError {
    match error {
        StoreError::Unauthorized => invalid(),
        other => other.into(),
    }
}

fn invalid() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "captcha_invalid",
        "Verification expired or failed. Try again.",
    )
}
