//! Snapshot command results are references, not another copy of conversation data.
use serde_json::{Value, json};

pub(super) fn compact(command: &mut Value) {
    let Some(method) = command.get("method").and_then(Value::as_str) else {
        return;
    };
    if !matches!(
        method,
        "_deskfleet/session/create"
            | "_deskfleet/session/fork"
            | "_deskfleet/session/rename"
            | "_deskfleet/session/read"
            | "_deskfleet/session/unread"
            | "_deskfleet/session/switch-agent"
            | "_deskfleet/session/resume"
            | "_deskfleet/session/stop"
            | "_deskfleet/session/archive"
            | "_deskfleet/session/restore"
    ) {
        return;
    }
    if let Some(id) = command
        .pointer("/result/session/id")
        .and_then(Value::as_str)
    {
        command["result"] = json!({"kind": "session_snapshot", "sessionId": id});
    }
}

pub(super) fn compact_event(event: &mut Value) {
    if event.get("kind").and_then(Value::as_str) == Some("command")
        && let Some(command) = event.get_mut("payload")
    {
        compact(command);
    }
}
