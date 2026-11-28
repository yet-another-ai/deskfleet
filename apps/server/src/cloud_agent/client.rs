use super::{ApiError, Result};
use actix_web::http::StatusCode;
use reqwest::{Client, Method, RequestBuilder, Url};
use std::{env, time::Duration};

#[derive(Clone)]
pub(crate) struct EveClient {
    client: Client,
    base: Url,
    secret: String,
}

impl EveClient {
    pub(super) fn authenticate_service(&self, req: &actix_web::HttpRequest) -> Result<()> {
        use sha2::{Digest, Sha256};
        let token = req
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(ApiError::unauthorized)?;
        if openssl::memcmp::eq(&Sha256::digest(token), &Sha256::digest(&self.secret)) {
            Ok(())
        } else {
            Err(ApiError::unauthorized())
        }
    }

    pub(crate) fn from_env() -> Result<Option<Self>> {
        let url = setting("DESKFLEET_SUPER_AGENT_URL");
        let secret = setting("DESKFLEET_SUPER_AGENT_SECRET");
        match (url, secret) {
            (None, None) => Ok(None),
            (Some(url), Some(secret)) => Self::new(&url, secret).map(Some),
            _ => Err(ApiError::bad(
                "Super Agent URL and secret must be configured together",
            )),
        }
    }

    pub(super) fn new(base: &str, secret: String) -> Result<Self> {
        let invalid_url = || ApiError::bad("invalid Super Agent runtime URL");
        let base = Url::parse(base).map_err(|_| invalid_url())?;
        if !matches!(base.scheme(), "http" | "https")
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err(invalid_url());
        }
        reqwest::header::HeaderValue::from_str(&format!("Bearer {secret}"))
            .map_err(|_| ApiError::bad("invalid Super Agent credential"))?;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| ApiError::internal())?;
        Ok(Self {
            client,
            base,
            secret,
        })
    }

    fn request(&self, method: Method, segments: &[&str]) -> Result<RequestBuilder> {
        if !segments.iter().all(|segment| valid_segment(segment)) {
            return Err(ApiError::bad("invalid Super Agent route"));
        }
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|()| ApiError::internal())?
            .pop_if_empty()
            .extend(segments);
        Ok(self.client.request(method, url).bearer_auth(&self.secret))
    }
    pub(crate) fn get(&self, segments: &[&str]) -> Result<RequestBuilder> {
        self.request(Method::GET, segments)
    }
    pub(super) fn post(&self, segments: &[&str]) -> Result<RequestBuilder> {
        Ok(self
            .request(Method::POST, segments)?
            .timeout(Duration::from_secs(60)))
    }
}

pub(super) fn valid_segment(id: &str) -> bool {
    !id.is_empty()
        && !matches!(id, "." | "..")
        && !id.contains(['/', '\\'])
        && !id.chars().any(char::is_control)
}

fn setting(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.is_empty())
}

pub(super) fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "super_agent_unavailable",
        "Super Agent is unavailable",
    )
}

pub(super) async fn send(request: RequestBuilder) -> Result<reqwest::Response> {
    let response = request.send().await.map_err(|_| unavailable())?;
    checked(response)
}

#[derive(Clone, Copy)]
pub(super) enum SessionControl {
    Cancel,
    End,
}

impl EveClient {
    pub(super) async fn stop_session(&self, session: &str, control: SessionControl) -> Result<()> {
        let action = match control {
            SessionControl::Cancel => "cancel",
            SessionControl::End => "end",
        };
        let response = self
            .post(&["eve", "v1", "session", session, action])?
            .send()
            .await
            .map_err(|_| unavailable())?;
        if matches!(response.status().as_u16(), 409 | 410) {
            let error: serde_json::Value = response.json().await.map_err(|_| unavailable())?;
            let code = error["code"].as_str();
            // Retried end/cancel may find a retired Session. A stranded Session cannot
            // do work, but Eve still requires an explicit end to retire its workflow.
            if matches!(code, Some("session_not_active" | "session_expired"))
                || (matches!(control, SessionControl::Cancel) && code == Some("session_stranded"))
            {
                return Ok(());
            }
            return Err(conflict());
        }
        checked(response).map(|_| ())
    }
}

fn conflict() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "super_agent_conflict",
        "Super Agent session cannot accept this request",
    )
}

fn checked(response: reqwest::Response) -> Result<reqwest::Response> {
    match response.status().as_u16() {
        200..=299 => Ok(response),
        400 => Err(ApiError::bad("Super Agent rejected the request")),
        413 => Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid_request",
            "Super Agent attachment exceeds the runtime size limit",
        )),
        415 => Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "invalid_request",
            "Super Agent does not accept this attachment type",
        )),
        404 => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "Super Agent session was not found",
        )),
        409 => Err(conflict()),
        _ => Err(unavailable()),
    }
}
