//! Cloudflare's credential API and single-customer aggregate analytics queries.
use crate::error::{ApiError, Result};
use actix_web::http::StatusCode;
use deskfleet_control_store::CloudflareTurnDailyUsage;
use deskfleet_protocol::control::IceServer;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;

#[derive(Debug)]
pub(super) struct UsageSnapshot {
    pub egress_bytes: i64,
    pub days: Option<Vec<CloudflareTurnDailyUsage>>,
}

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
    ) -> Result<UsageSnapshot> {
        // JSON strings are also GraphQL string literals. Escaping every scalar
        // avoids interpolating identifiers or settings as query syntax.
        let account = json!(account_id);
        let key = json!(key_id);
        let identifier = json!(identifier);
        let day_start = start.div_euclid(DAY_MS) * DAY_MS;
        let daily_start = json!(deskfleet_control_store::timestamp(day_start));
        let range_start = json!(deskfleet_control_store::timestamp(start));
        let range_end = json!(deskfleet_control_store::timestamp(end));
        let query = format!(
            "query {{ viewer {{ accounts(filter: {{accountTag: {account}}}) {{ \
             callsTurnUsageAdaptiveGroups(limit: 1, filter: {{keyId: {key}, \
             customIdentifier: {identifier}, datetime_geq: {range_start}, datetime_lt: {range_end}}}) \
             {{ sum {{ egressBytes }} }} \
             daily: callsTurnUsageAdaptiveGroups(limit: 1000, filter: {{keyId: {key}, \
             customIdentifier: {identifier}, datetime_geq: {daily_start}, datetime_lt: {range_end}}}, \
             orderBy: [datetimeHour_ASC]) {{ dimensions {{ datetimeHour }} sum {{ egressBytes }} }} \
             }} }} }}"
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
        let daily_failed = daily_query_failed(&response)?;
        Ok(UsageSnapshot {
            egress_bytes: usage_bytes(&response)?,
            // Daily-only provider errors and malformed timeseries must not discard
            // a valid billing aggregate. Unset coverage keeps this window retryable.
            days: if daily_failed {
                None
            } else {
                daily_usage(&response, day_start, end).ok()
            },
        })
    }
}

/// Only errors explicitly scoped to the optional daily alias can spare billing.
fn daily_query_failed(response: &Value) -> Result<bool> {
    let Some(errors) = response.get("errors").filter(|value| !value.is_null()) else {
        return Ok(false);
    };
    let errors = errors.as_array().ok_or_else(unavailable)?;
    for error in errors {
        let path = error["path"].as_array().ok_or_else(unavailable)?;
        if !matches!(path.as_slice(), [viewer, accounts, index, alias, tail @ ..]
            if viewer == "viewer" && accounts == "accounts" && index.as_u64() == Some(0)
                && alias == "daily"
                && tail.iter().all(|part| part.is_string() || part.as_u64().is_some()))
        {
            return Err(unavailable());
        }
    }
    Ok(!errors.is_empty())
}

fn daily_usage(response: &Value, start: i64, end: i64) -> Result<Vec<CloudflareTurnDailyUsage>> {
    if start >= end || end - start > 32 * DAY_MS {
        return Err(unavailable());
    }
    let groups = response["data"]["viewer"]["accounts"][0]["daily"]
        .as_array()
        .ok_or_else(unavailable)?;
    // A monthly window has at most 768 hourly groups. The larger API limit
    // cannot truncate a valid response at this granularity.
    let mut days = (start..end)
        .step_by(DAY_MS as usize)
        .map(|day_start| CloudflareTurnDailyUsage {
            day_start,
            egress_bytes: 0,
        })
        .collect::<Vec<_>>();
    let mut seen = std::collections::BTreeSet::new();
    for group in groups {
        let hour = group["dimensions"]["datetimeHour"]
            .as_str()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.timestamp_millis())
            .ok_or_else(unavailable)?;
        if hour < start || hour >= end || hour % HOUR_MS != 0 || !seen.insert(hour) {
            return Err(unavailable());
        }
        let index = usize::try_from((hour - start) / DAY_MS).map_err(|_| unavailable())?;
        let bytes = counter(&group["sum"]["egressBytes"])?;
        days[index].egress_bytes = days[index]
            .egress_bytes
            .checked_add(bytes)
            .ok_or_else(unavailable)?;
    }
    Ok(days)
}

fn usage_bytes(response: &Value) -> Result<i64> {
    let accounts = response["data"]["viewer"]["accounts"]
        .as_array()
        .filter(|accounts| accounts.len() == 1)
        .ok_or_else(unavailable)?;
    let groups = accounts[0]["callsTurnUsageAdaptiveGroups"]
        .as_array()
        .ok_or_else(unavailable)?;
    match groups.as_slice() {
        [] => Ok(0),
        [group] => counter(&group["sum"]["egressBytes"]),
        _ => Err(unavailable()),
    }
}

fn counter(value: &Value) -> Result<i64> {
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

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
