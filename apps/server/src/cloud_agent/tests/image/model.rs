//! Scripted Chat Completions stream for the real Eve instance in the image test.
use super::*;

const DISCOVER: &str = "deskfleet__deskfleet_remote_machines";
const DISPATCH: &str = "deskfleet__deskfleet_remote_session_create";
pub(super) const COMPLETED: &str = "The smoke worker accepted the task.";
pub(super) const FOLLOW_UP: &str = "Send the follow-up to the same worker.";
pub(super) const CONTINUED: &str = "The worker accepted the follow-up.";

pub(super) async fn chat(body: web::Json<Value>, machine_id: web::Data<String>) -> HttpResponse {
    let messages = body["messages"].as_array().unwrap();
    let follow_up = messages
        .iter()
        .any(|m| m["role"] == "user" && m["content"].to_string().contains(FOLLOW_UP));
    let result = messages
        .iter()
        .rev()
        .find(|item| item["role"] == "tool")
        .map(|item| item["content"].to_string());
    let (delta, reason) = match result {
        None => call(
            "search",
            "eve__search",
            json!({"query": "deskfleet__", "limit": 50}),
        ),
        Some(result) if result.contains(DISCOVER) && result.contains(DISPATCH) => {
            call("discover", "eve__tool", json!({"name": DISCOVER}))
        }
        Some(result) if result.contains("image-smoke-worker") => call(
            "dispatch",
            "eve__tool",
            json!({"name": DISPATCH, "input": {
                "machineId": machine_id.get_ref(), "provider": "codex", "prompt": "Run the fixture task"
            }}),
        ),
        Some(result) if result.contains("accepted-fixture-session") && follow_up => call(
            "send",
            "eve__tool",
            json!({"name":"deskfleet__deskfleet_remote_session_send","input":{
                "machineId":machine_id.get_ref(),"sessionId":"accepted-fixture-session","prompt":"Continue the fixture task"
            }}),
        ),
        Some(result) if result.contains("continued-fixture-session") => {
            (json!({"content": CONTINUED}), "stop")
        }
        Some(result) if result.contains("accepted-fixture-session") => {
            (json!({"content": COMPLETED}), "stop")
        }
        Some(result) => (
            json!({"content": format!("Unexpected tool result: {result}")}),
            "stop",
        ),
    };
    let chunk = |delta: Value, reason: Option<&str>| {
        json!({
            "id": "chatcmpl-smoke", "model": "smoke-model", "object": "chat.completion.chunk", "created": 1,
            "choices": [{"index": 0, "delta": delta, "finish_reason": reason}]
        })
    };
    HttpResponse::Ok()
        .content_type("text/event-stream")
        .body(format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            chunk(delta, None),
            chunk(json!({}), Some(reason))
        ))
}

fn call(id: &str, name: &str, input: Value) -> (Value, &'static str) {
    (
        json!({"role":"assistant", "tool_calls":[{
            "index": 0, "id": id, "type": "function",
            "function":{"name": name, "arguments": input.to_string()}
        }]}),
        "tool_calls",
    )
}
