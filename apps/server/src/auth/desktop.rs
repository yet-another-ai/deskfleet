use super::passwords::field;
use super::*;
use deskfleet_control_store::secret_hash;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Start {
    return_to: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Complete {
    attempt: String,
    #[serde(default)]
    telemetry_consent: Option<deskfleet_protocol::control::TelemetryConsentUpdate>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Exchange {
    code: String,
    login_verifier: String,
}

/// Loopback callbacks keep the code in the fragment. macOS delivers custom
/// schemes through LaunchServices, so the desktop scheme uses the query string
/// instead to avoid losing the one-use code on the way to the app.
fn callback_url(return_to: &str, code: &str) -> Option<url::Url> {
    let mut url = url::Url::parse(return_to).ok()?;
    if url.scheme() == "deskfleet" {
        url.query_pairs_mut().append_pair("loginCode", code);
    } else {
        url.set_fragment(Some(&format!("loginCode={code}")));
    }
    Some(url)
}

fn allowed_return_to(allowlist: &[String], value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return false;
    }
    allowlist.iter().any(|allowed| {
        allowed == value
            || (allowed == "http://127.0.0.1:*/auth/callback"
                && url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port().is_some()
                && url.path() == "/auth/callback"
                && url.query().is_none())
    })
}
pub(super) async fn start(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Start>,
) -> Result<web::Json<Value>> {
    limit(&req, &state, "desktop_start", None).await?;
    if !allowed_return_to(&state.auth.config.return_to, &body.return_to) {
        return Err(ApiError::bad("login return URL is not allowed"));
    }
    let attempt = secret();
    let verifier = secret();
    state
        .store
        .save_login_attempt(
            &attempt,
            json!({"returnTo":body.return_to,"loginVerifierHash":secret_hash(&verifier)}),
        )
        .await?;
    let mut url = url::Url::parse(&format!("{}/auth/desktop", state.auth.config.web_url))
        .map_err(|_| ApiError::internal())?;
    url.query_pairs_mut().append_pair("attempt", &attempt);
    Ok(web::Json(
        json!({"authorizationUrl":url.to_string(),"loginVerifier":verifier}),
    ))
}
pub(super) async fn complete(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Complete>,
) -> Result<web::Json<Value>> {
    let auth = recent(&req, &state).await?;
    let attempt = state.store.consume_login_attempt(&body.attempt).await?;
    if let Some(consent) = &body.telemetry_consent {
        state
            .store
            .update_user_telemetry_consent(&auth.user.id, consent)
            .await?;
    }
    let code = state
        .store
        .new_login_code_for_session(
            &auth.user.id,
            &auth.id,
            field(&attempt, "loginVerifierHash")?,
        )
        .await?;
    let url = callback_url(field(&attempt, "returnTo")?, &code).ok_or_else(ApiError::internal)?;
    Ok(web::Json(json!({"returnTo":url.to_string()})))
}
pub(super) async fn exchange(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<Exchange>,
) -> Result<HttpResponse> {
    limit(&req, &state, "desktop_exchange", None).await?;
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(
            state
                .store
                .exchange_login_code(&body.code, &body.login_verifier)
                .await?,
        ))
}
#[cfg(test)]
mod tests {
    #[test]
    fn callbacks_are_loopback_and_exact() {
        let allowed = vec![
            "http://127.0.0.1:*/auth/callback".into(),
            "ai.yetanother.deskfleet://auth/callback".into(),
            "deskfleet://auth/callback".into(),
        ];
        assert!(super::allowed_return_to(
            &allowed,
            "http://127.0.0.1:3456/auth/callback"
        ));
        assert!(super::allowed_return_to(
            &allowed,
            "ai.yetanother.deskfleet://auth/callback"
        ));
        assert!(super::allowed_return_to(
            &allowed,
            "deskfleet://auth/callback"
        ));
        for invalid in [
            "http://localhost:3456/auth/callback",
            "http://127.0.0.1:3456/evil",
            "http://127.0.0.1:3456/auth/callback?evil",
            "http://user@127.0.0.1:3456/auth/callback",
            "ai.yetanother.deskfleet://auth/callback?evil",
            "ai.yetanother.deskfleet://auth/callback#frag",
            "deskfleet://auth/callback?evil",
            "deskfleet://auth/callback#frag",
            "deskfleet://other/callback",
        ] {
            assert!(!super::allowed_return_to(&allowed, invalid));
        }
    }

    #[test]
    fn desktop_scheme_delivers_the_code_in_the_query() {
        let url = super::callback_url("deskfleet://auth/callback", "df_code").unwrap();
        assert_eq!(url.as_str(), "deskfleet://auth/callback?loginCode=df_code");
        assert!(url.fragment().is_none());
    }

    #[test]
    fn loopback_and_mobile_callbacks_keep_the_fragment() {
        for return_to in [
            "http://127.0.0.1:3456/auth/callback",
            "ai.yetanother.deskfleet://auth/callback",
        ] {
            let url = super::callback_url(return_to, "df_code").unwrap();
            assert_eq!(url.fragment(), Some("loginCode=df_code"));
            assert!(url.query().is_none());
        }
    }
}
