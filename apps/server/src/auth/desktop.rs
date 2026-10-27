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
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Exchange {
    code: String,
    login_verifier: String,
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
    let code = state
        .store
        .new_login_code_for_session(
            &auth.user.id,
            &auth.id,
            field(&attempt, "loginVerifierHash")?,
        )
        .await?;
    let mut url =
        url::Url::parse(field(&attempt, "returnTo")?).map_err(|_| ApiError::internal())?;
    url.set_fragment(Some(&format!("loginCode={code}")));
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
        let allowed = vec!["http://127.0.0.1:*/auth/callback".into()];
        assert!(super::allowed_return_to(
            &allowed,
            "http://127.0.0.1:3456/auth/callback"
        ));
        for invalid in [
            "http://localhost:3456/auth/callback",
            "http://127.0.0.1:3456/evil",
            "http://127.0.0.1:3456/auth/callback?evil",
            "http://user@127.0.0.1:3456/auth/callback",
        ] {
            assert!(!super::allowed_return_to(&allowed, invalid));
        }
    }
}
