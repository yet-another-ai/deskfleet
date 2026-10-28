use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Counts {
    pub total_tokens: u64,
    pub turn_count: u64,
    pub reported_turn_count: u64,
}

impl Counts {
    pub fn add(&mut self, usage: Option<&Usage>) {
        self.turn_count = self.turn_count.saturating_add(1);
        if let Some(usage) = usage {
            self.total_tokens = self.total_tokens.saturating_add(usage.total_tokens);
            self.reported_turn_count = self.reported_turn_count.saturating_add(1);
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Totals {
    #[serde(flatten)]
    pub counts: Counts,
    input_tokens: u64,
    output_tokens: u64,
    cached_read_tokens: Option<u64>,
    cached_write_tokens: Option<u64>,
    thought_tokens: Option<u64>,
}

impl Totals {
    pub fn add(&mut self, usage: Option<&Usage>) {
        self.counts.add(usage);
        if let Some(usage) = usage {
            self.input_tokens = self.input_tokens.saturating_add(usage.input_tokens);
            self.output_tokens = self.output_tokens.saturating_add(usage.output_tokens);
            add_optional(&mut self.cached_read_tokens, usage.cached_read_tokens);
            add_optional(&mut self.cached_write_tokens, usage.cached_write_tokens);
            add_optional(&mut self.thought_tokens, usage.thought_tokens);
        }
    }
}

fn add_optional(total: &mut Option<u64>, value: Option<u64>) {
    if let Some(value) = value {
        *total = Some(total.unwrap_or_default().saturating_add(value));
    }
}

/// ACP reports the total independently; cache and thought counts may overlap it.
pub(super) struct Usage {
    total_tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    cached_read_tokens: Option<u64>,
    cached_write_tokens: Option<u64>,
    thought_tokens: Option<u64>,
}

impl Usage {
    pub fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            total_tokens: value.get("totalTokens")?.as_u64()?,
            input_tokens: value.get("inputTokens")?.as_u64()?,
            output_tokens: value.get("outputTokens")?.as_u64()?,
            cached_read_tokens: value.get("cachedReadTokens").and_then(Value::as_u64),
            cached_write_tokens: value.get("cachedWriteTokens").and_then(Value::as_u64),
            thought_tokens: value.get("thoughtTokens").and_then(Value::as_u64),
        })
    }

    pub fn total_tokens(&self) -> u64 {
        self.total_tokens
    }
}

#[derive(Serialize)]
pub(super) struct Group {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub counts: Counts,
}

#[derive(Default, Serialize)]
pub(super) struct Bucket {
    pub start: String,
    #[serde(flatten)]
    pub counts: Counts,
    pub models: BTreeMap<String, u64>,
    pub members: BTreeMap<String, u64>,
}

#[derive(Serialize)]
pub(super) struct Day {
    pub date: String,
    #[serde(flatten)]
    pub counts: Counts,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Session {
    pub machine_id: String,
    pub machine_name: String,
    pub session_id: String,
    pub title: String,
    #[serde(flatten)]
    pub totals: Totals,
}

pub(super) struct Turn {
    pub ended_at: i64,
    pub date: String,
    pub day_start: i64,
    pub model_id: String,
    pub model_name: String,
    pub member_id: String,
    pub member_name: String,
    pub machine_id: String,
    pub machine_name: String,
    pub session_id: String,
    pub title: String,
    pub usage: Option<Usage>,
}
