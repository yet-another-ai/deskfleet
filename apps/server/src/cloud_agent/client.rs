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
    match response.status().as_u16() {
        200..=299 => Ok(response),
        400 | 413 => Err(ApiError::bad("Super Agent rejected the request")),
        404 => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "Super Agent session was not found",
        )),
        409 => Err(ApiError::new(
            StatusCode::CONFLICT,
            "super_agent_conflict",
            "Super Agent session cannot accept this request",
        )),
        _ => Err(unavailable()),
    }
}
