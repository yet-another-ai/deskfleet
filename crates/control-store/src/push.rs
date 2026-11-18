//! Mobile push notification subscriptions and task event extraction.
use std::collections::BTreeSet;

use crate::entities::{
    cp_login_sessions as login_sessions, cp_members as members,
    cp_push_subscriptions as push_subscriptions, cp_users as users,
};
use crate::{ControlStore, Error, Result, now_ms, resource_id};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Set, TransactionTrait,
    sea_query::{Expr, ExprTrait, JoinType, OnConflict, Order, Query},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_SNIPPET_CHARS: usize = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PushChannel {
    Apns,
    Fcm,
}

impl PushChannel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Apns => "apns",
            Self::Fcm => "fcm",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "apns" => Ok(Self::Apns),
            "fcm" => Ok(Self::Fcm),
            _ => Err(Error::Invalid("invalid push channel")),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PushNotificationSettings {
    pub enabled: bool,
    pub task_completed: bool,
    pub task_needs_input: bool,
}

impl Default for PushNotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            task_completed: true,
            task_needs_input: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PushSubscriptionInput {
    pub channel: PushChannel,
    pub token: String,
    pub locale: String,
    pub settings: PushNotificationSettings,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushSubscriptionTarget {
    pub login_session_id: String,
    pub user_id: String,
    pub channel: PushChannel,
    pub token: String,
    pub locale: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskNotificationKind {
    TaskCompleted,
    TaskNeedsInput,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionTaskNotification {
    pub kind: TaskNotificationKind,
    pub session_id: String,
    pub title: String,
    pub detail: Option<String>,
    pub user_ids: Vec<String>,
}

fn compact_snippet(raw: &str) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    let mut chars = collapsed.chars();
    let head: String = chars.by_ref().take(MAX_SNIPPET_CHARS).collect();
    Some(if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    })
}

fn session_participant_ids(snapshot: &Value, events: &[Value]) -> Vec<String> {
    let mut ids = BTreeSet::new();
    let mut push = |value: Option<&Value>| {
        if let Some(id) = value.and_then(Value::as_str).map(str::trim)
            && !id.is_empty()
        {
            ids.insert(id.to_owned());
        }
    };
    push(snapshot.pointer("/session/yoloActor/userId"));
    for viewer in snapshot["session"]["viewers"]
        .as_array()
        .into_iter()
        .flatten()
    {
        push(viewer.get("userId"));
    }
    for input in snapshot["inputs"].as_array().into_iter().flatten() {
        push(input.pointer("/author/userId"));
    }
    for key in ["permissions", "elicitations"] {
        for item in snapshot[key].as_array().into_iter().flatten() {
            push(item.pointer("/actor/userId"));
        }
    }
    for event in events {
        push(event.pointer("/payload/author/userId"));
        push(event.pointer("/payload/actor/userId"));
    }
    ids.into_iter().collect()
}

fn assistant_turn_snippet(events: &[Value], turn_id: Option<&str>) -> Option<String> {
    let mut text = String::new();
    for event in events {
        if event["kind"] != "acp" {
            continue;
        }
        if let Some(target_turn) = turn_id
            && let Some(event_turn) = event["turnId"].as_str()
            && event_turn != target_turn
        {
            continue;
        }
        let update = &event["payload"]["update"];
        if update["sessionUpdate"] == "agent_message_chunk"
            && update["content"]["type"] == "text"
            && let Some(chunk) = update["content"]["text"].as_str()
        {
            text.push_str(chunk);
        }
    }
    compact_snippet(&text)
}

pub(crate) fn extract_session_notifications(
    session_id: &str,
    snapshot: &Value,
    events: &[Value],
) -> Vec<SessionTaskNotification> {
    let session = &snapshot["session"];
    if session["archiveState"].as_str() != Some("active")
        || session["lifecycle"].as_str() != Some("ready")
    {
        return Vec::new();
    }
    let user_ids = session_participant_ids(snapshot, events);
    if user_ids.is_empty() {
        return Vec::new();
    }
    let title = session["title"].as_str().unwrap_or_default();
    events
        .iter()
        .filter_map(|event| {
            let payload = &event["payload"];
            let (kind, detail) = match (event["kind"].as_str(), payload["state"].as_str()) {
                (Some("turn"), Some("completed")) => (
                    TaskNotificationKind::TaskCompleted,
                    assistant_turn_snippet(events, payload["id"].as_str()),
                ),
                (Some("permission"), Some("pending")) => (
                    TaskNotificationKind::TaskNeedsInput,
                    payload
                        .pointer("/request/toolCall/title")
                        .or_else(|| payload.pointer("/request/toolCall/name"))
                        .and_then(Value::as_str)
                        .and_then(compact_snippet),
                ),
                (Some("elicitation"), Some("pending")) => (
                    TaskNotificationKind::TaskNeedsInput,
                    payload
                        .pointer("/request/message")
                        .and_then(Value::as_str)
                        .and_then(compact_snippet),
                ),
                _ => return None,
            };
            Some(SessionTaskNotification {
                kind,
                session_id: session_id.to_owned(),
                title: title.to_owned(),
                detail,
                user_ids: user_ids.clone(),
            })
        })
        .collect()
}

fn validate_token(channel: PushChannel, token: &str) -> Result<String> {
    let trimmed = token.trim();
    if trimmed.is_empty() || trimmed.len() > 4096 || trimmed.chars().any(char::is_control) {
        return Err(Error::Invalid("invalid push device token"));
    }
    if channel == PushChannel::Apns
        && (trimmed.len() < 32 || !trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(Error::Invalid("invalid APNs device token"));
    }
    Ok(trimmed.to_owned())
}

fn normalize_locale(locale: &str) -> String {
    let lower = locale.trim().to_ascii_lowercase();
    if lower.starts_with("zh") {
        "zh-cmn-Hans-CN".to_owned()
    } else if lower.starts_with("ja") {
        "ja-JP".to_owned()
    } else {
        "en-US".to_owned()
    }
}

impl ControlStore {
    pub async fn save_push_subscription(
        &self,
        login_session_id: &str,
        user_id: &str,
        input: &PushSubscriptionInput,
    ) -> Result<()> {
        let token = validate_token(input.channel, &input.token)?;
        let locale = normalize_locale(&input.locale);
        let channel = input.channel.as_str().to_owned();
        let tx = self.db.begin().await?;
        push_subscriptions::Entity::delete_many()
            .filter(push_subscriptions::Column::Channel.eq(&channel))
            .filter(push_subscriptions::Column::Token.eq(&token))
            .filter(push_subscriptions::Column::LoginSessionId.ne(login_session_id))
            .exec(&tx)
            .await?;
        push_subscriptions::Entity::insert(push_subscriptions::ActiveModel {
            login_session_id: Set(login_session_id.to_owned()),
            user_id: Set(user_id.to_owned()),
            channel: Set(channel),
            token: Set(token),
            locale: Set(locale),
            enabled: Set(input.settings.enabled),
            task_completed: Set(input.settings.task_completed),
            task_needs_input: Set(input.settings.task_needs_input),
            updated_at: Set(now_ms()),
        })
        .on_conflict(
            OnConflict::column(push_subscriptions::Column::LoginSessionId)
                .update_columns([
                    push_subscriptions::Column::UserId,
                    push_subscriptions::Column::Channel,
                    push_subscriptions::Column::Token,
                    push_subscriptions::Column::Locale,
                    push_subscriptions::Column::Enabled,
                    push_subscriptions::Column::TaskCompleted,
                    push_subscriptions::Column::TaskNeedsInput,
                    push_subscriptions::Column::UpdatedAt,
                ])
                .to_owned(),
        )
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn remove_push_subscription(&self, login_session_id: &str) -> Result<()> {
        push_subscriptions::Entity::delete_many()
            .filter(push_subscriptions::Column::LoginSessionId.eq(login_session_id))
            .exec(&self.db)
            .await?;
        Ok(())
    }

    pub async fn remove_push_device_token(&self, channel: PushChannel, token: &str) -> Result<()> {
        push_subscriptions::Entity::delete_many()
            .filter(push_subscriptions::Column::Channel.eq(channel.as_str()))
            .filter(push_subscriptions::Column::Token.eq(token))
            .exec(&self.db)
            .await?;
        Ok(())
    }

    pub async fn team_push_targets(
        &self,
        team_id: &str,
        kind: TaskNotificationKind,
        user_ids: &[String],
    ) -> Result<Vec<PushSubscriptionTarget>> {
        if user_ids.is_empty() {
            return Ok(Vec::new());
        }
        use push_subscriptions::{Column as SubCol, Entity as Sub};
        let team = resource_id(team_id)?;
        let kind_col = match kind {
            TaskNotificationKind::TaskCompleted => SubCol::TaskCompleted,
            TaskNotificationKind::TaskNeedsInput => SubCol::TaskNeedsInput,
        };
        let rows = self
            .db
            .query_all(
                Query::select()
                    .columns([
                        (Sub, SubCol::LoginSessionId),
                        (Sub, SubCol::UserId),
                        (Sub, SubCol::Channel),
                        (Sub, SubCol::Token),
                        (Sub, SubCol::Locale),
                    ])
                    .from(Sub)
                    .join(
                        JoinType::InnerJoin,
                        login_sessions::Entity,
                        Expr::col((login_sessions::Entity, login_sessions::Column::Id))
                            .eq(Expr::col((Sub, SubCol::LoginSessionId))),
                    )
                    .join(
                        JoinType::InnerJoin,
                        users::Entity,
                        Expr::col((users::Entity, users::Column::Id))
                            .eq(Expr::col((Sub, SubCol::UserId))),
                    )
                    .join(
                        JoinType::InnerJoin,
                        members::Entity,
                        Expr::col((members::Entity, members::Column::UserId))
                            .eq(Expr::col((Sub, SubCol::UserId))),
                    )
                    .and_where(Expr::col((members::Entity, members::Column::TeamId)).eq(team))
                    .and_where(Expr::col((Sub, SubCol::UserId)).is_in(user_ids.iter().cloned()))
                    .and_where(Expr::col((users::Entity, users::Column::Disabled)).eq(false))
                    .and_where(
                        Expr::col((login_sessions::Entity, login_sessions::Column::Revoked))
                            .eq(false),
                    )
                    .and_where(
                        Expr::col((login_sessions::Entity, login_sessions::Column::ExpiresAt))
                            .gt(now_ms()),
                    )
                    .and_where(Expr::col((Sub, SubCol::Enabled)).eq(true))
                    .and_where(Expr::col((Sub, kind_col)).eq(true))
                    .order_by((Sub, SubCol::LoginSessionId), Order::Asc),
            )
            .await?;

        rows.into_iter()
            .map(|row| {
                Ok(PushSubscriptionTarget {
                    login_session_id: row.try_get("", "login_session_id")?,
                    user_id: row.try_get("", "user_id")?,
                    channel: PushChannel::parse(&row.try_get::<String>("", "channel")?)?,
                    token: row.try_get("", "token")?,
                    locale: row.try_get("", "locale")?,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_participant_notifications_with_tool_and_reply_details() {
        let snap = json!({
            "session": {
                "id": "12",
                "title": "Fix push",
                "archiveState": "active",
                "lifecycle": "ready",
                "viewers": [{"userId": "u2", "seenAt": "2026-01-01T00:00:00Z"}]
            },
            "inputs": [{"id": "i1", "author": {"kind": "user", "userId": "u1"}}]
        });
        let events = vec![
            json!({"kind": "acp", "turnId": "t1", "payload": {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "All tests\npassed."}}}}),
            json!({"kind": "turn", "payload": {"id": "t1", "state": "completed"}}),
            json!({"kind": "permission", "payload": {"state": "pending", "request": {"toolCall": {"title": "cargo test"}}}}),
            json!({"kind": "elicitation", "payload": {"state": "pending", "request": {"message": "Which channel?"}}}),
        ];
        assert_eq!(
            extract_session_notifications("12", &snap, &events),
            vec![
                SessionTaskNotification {
                    kind: TaskNotificationKind::TaskCompleted,
                    session_id: "12".into(),
                    title: "Fix push".into(),
                    detail: Some("All tests passed.".into()),
                    user_ids: vec!["u1".into(), "u2".into()],
                },
                SessionTaskNotification {
                    kind: TaskNotificationKind::TaskNeedsInput,
                    session_id: "12".into(),
                    title: "Fix push".into(),
                    detail: Some("cargo test".into()),
                    user_ids: vec!["u1".into(), "u2".into()],
                },
                SessionTaskNotification {
                    kind: TaskNotificationKind::TaskNeedsInput,
                    session_id: "12".into(),
                    title: "Fix push".into(),
                    detail: Some("Which channel?".into()),
                    user_ids: vec!["u1".into(), "u2".into()],
                },
            ]
        );
        let no_users = json!({"session": {"id": "12", "title": "Local", "archiveState": "active", "lifecycle": "ready"}});
        assert!(extract_session_notifications("12", &no_users, &events).is_empty());
    }

    #[test]
    fn validates_tokens_and_normalizes_locales() {
        assert!(validate_token(PushChannel::Apns, &"a1".repeat(32)).is_ok());
        assert!(validate_token(PushChannel::Apns, "not-hex-token").is_err());
        assert!(validate_token(PushChannel::Fcm, "fcm-registration-token:APA91bF").is_ok());
        assert!(validate_token(PushChannel::Fcm, "   ").is_err());
        assert_eq!(normalize_locale("zh-CN"), "zh-cmn-Hans-CN");
        assert_eq!(normalize_locale("ja"), "ja-JP");
        assert_eq!(normalize_locale("en-GB"), "en-US");
    }
}
