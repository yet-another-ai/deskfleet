//! Mailbox confirmation for an authenticated user's sensitive actions.
use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Verification {
    challenge_id: String,
    code: String,
}

pub(super) async fn send(req: HttpRequest, state: web::Data<AppState>) -> Result<HttpResponse> {
    let auth = user(&req, &state).await?;
    limit(&req, &state, "reauthentication_mail", Some(&auth.user.id)).await?;
    let allowed = state
        .store
        .auth_rate_limit(
            &format!("reauthentication_mail:minute:{}", auth.user.id),
            1,
            60_000,
        )
        .await?;
    let hourly = state
        .store
        .auth_rate_limit(
            &format!("reauthentication_mail:hour:{}", auth.user.id),
            10,
            3_600_000,
        )
        .await?;
    if !allowed || !hourly {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many requests. Try again later.",
        ));
    }
    let (challenge, code, email) = state
        .store
        .issue_email_authentication(&auth.user.id, &auth.id)
        .await?;
    state.auth.mail.send(&email, "Your DeskFleet verification code", &format!(
        "Your DeskFleet verification code is: {code}\n\nEnter this code in the window where you requested it to confirm a sensitive account action. It expires in 10 minutes and can be used once. Do not share this code. If you did not request it, ignore this message."
    )).await?;
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(json!({"challengeId":challenge,"expiresIn":600,"retryAfter":60})))
}

pub(super) async fn verify(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Verification>,
) -> Result<HttpResponse> {
    let auth = user(&req, &state).await?;
    limit(&req, &state, "reauthenticate", Some(&auth.user.id)).await?;
    if body.challenge_id.len() > 128
        || body.code.len() != 6
        || !body.code.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ApiError::bad("Enter the six-digit verification code."));
    }
    state.store.verify_email_authentication(&auth.user.id, &auth.id, &body.challenge_id, &body.code).await.map_err(|error| match error {
        deskfleet_control_store::Error::Unauthorized => ApiError::new(StatusCode::BAD_REQUEST, "invalid_verification_code", "The code is incorrect, expired, or no longer usable. Request a new code if needed."),
        error => error.into(),
    })?;
    Ok(HttpResponse::NoContent()
        .insert_header(("Cache-Control", "no-store"))
        .finish())
}
