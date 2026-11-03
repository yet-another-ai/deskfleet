//! Cloudflare's credential API and single-customer aggregate analytics queries.
use crate::error::{ApiError, Result};
use actix_web::http::StatusCode;
use deskfleet_protocol::control::IceServer;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone)]
pub(super) struct Client {
    http: reqwest::Client,
    pub(super) credentials_url: String,
    pub(super) analytics_url: String,
}

fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "turn_service_unavailable",
        "Cloudflare TURN service is unavailable",
    )
}

impl Client {
    pub(super) fn new() -> Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| ApiError::internal())?,
            credentials_url: "https://rtc.live.cloudflare.com/v1/turn/keys".into(),
            analytics_url: "https://api.cloudflare.com/client/v4/graphql".into(),
        })
    }

    pub(super) async fn generate(
        &self,
        key_id: &str,
        token: &str,
        identifier: &str,
        ttl: i64,
    ) -> Result<Vec<IceServer>> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Credentials {
            ice_servers: Vec<IceServer>,
        }
        let mut url = url::Url::parse(&self.credentials_url).map_err(|_| ApiError::internal())?;
        url.path_segments_mut()
            .map_err(|_| ApiError::internal())?
            .push(key_id)
            .push("credentials")
            .push("generate-ice-servers");
        // Do not log provider response bodies or reqwest errors: they can contain
        // credentials. The client only receives a stable service error.
        let response = self
            .http
            .post(url)
            .bearer_auth(token)
            .json(&json!({"ttl": ttl, "customIdentifier": identifier}))
            .send()
            .await
            .map_err(|_| unavailable())?
            .error_for_status()
            .map_err(|_| unavailable())?
            .json::<Credentials>()
            .await
            .map_err(|_| unavailable())?;
        let mut relays = Vec::new();
        for mut server in response.ice_servers {
            // The site's STUN configuration remains authoritative. Cloudflare's
            // relay URLs use the provider-issued username and password together.
            server
                .urls
                .retain(|url| url.starts_with("turn:") || url.starts_with("turns:"));
            if server.urls.is_empty() {
                continue;
            }
            if server.username.as_deref().is_none_or(str::is_empty)
                || server.credential.as_deref().is_none_or(str::is_empty)
            {
                return Err(unavailable());
            }
            relays.push(server);
        }
        if relays.is_empty() {
            return Err(unavailable());
        }
        Ok(relays)
    }

    pub(super) async fn usage(
        &self,
        account_id: &str,
        key_id: &str,
        token: &str,
        identifier: &str,
        start: i64,
        end: i64,
    ) -> Result<i64> {
        // JSON strings are also GraphQL string literals. Escaping every scalar
        // avoids interpolating identifiers or settings as query syntax.
        let account = json!(account_id);
        let key = json!(key_id);
        let identifier = json!(identifier);
        let start = json!(deskfleet_control_store::timestamp(start));
        let end = json!(deskfleet_control_store::timestamp(end));
        let query = format!(
            "query {{ viewer {{ accounts(filter: {{accountTag: {account}}}) {{ \
             callsTurnUsageAdaptiveGroups(limit: 1, filter: {{keyId: {key}, \
             customIdentifier: {identifier}, datetime_geq: {start}, datetime_lt: {end}}}) \
             {{ sum {{ egressBytes }} }} }} }} }}"
        );
        let response = self
            .http
            .post(&self.analytics_url)
            .bearer_auth(token)
            .json(&json!({"query": query}))
            .send()
            .await
            .map_err(|_| unavailable())?
            .error_for_status()
            .map_err(|_| unavailable())?
            .json::<Value>()
            .await
            .map_err(|_| unavailable())?;
        usage_bytes(&response)
    }
}

fn usage_bytes(response: &Value) -> Result<i64> {
    if response
        .get("errors")
        .is_some_and(|errors| !errors.is_null() && errors.as_array().is_none_or(|v| !v.is_empty()))
    {
        return Err(unavailable());
    }
    let accounts = response["data"]["viewer"]["accounts"]
        .as_array()
        .filter(|accounts| accounts.len() == 1)
        .ok_or_else(unavailable)?;
    let groups = accounts[0]["callsTurnUsageAdaptiveGroups"]
        .as_array()
        .ok_or_else(unavailable)?;
    match groups.as_slice() {
        [] => Ok(0),
        [group] => {
            let value = &group["sum"]["egressBytes"];
            if let Some(bytes) = value.as_i64() {
                return (bytes >= 0).then_some(bytes).ok_or_else(unavailable);
            }
            // Preserve integer counters exactly; only sampled fractional
            // estimates need rounding, once after the provider's aggregation.
            let bytes = value.as_f64().ok_or_else(unavailable)?;
            if !bytes.is_finite() || !(0.0..9_223_372_036_854_775_808.0).contains(&bytes) {
                return Err(unavailable());
            }
            Ok(bytes.round() as i64)
        }
        _ => Err(unavailable()),
    }
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
