//! PostgreSQL JSONB cannot represent NUL, but ACP events can contain it.
use serde_json::{Value, json};

/// Keep exact replay data only when the searchable JSONB projection needs repair.
pub(super) fn encode(mut event: Value) -> Value {
    let original = contains_nul(&event).then(|| event.to_string());
    if original.is_some() {
        replace_nul(&mut event);
    }
    json!({"record": event, "original": original})
}

fn contains_nul(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains('\0'),
        Value::Array(values) => values.iter().any(contains_nul),
        Value::Object(fields) => fields
            .iter()
            .any(|(key, value)| key.contains('\0') || contains_nul(value)),
        _ => false,
    }
}

fn replace_nul(value: &mut Value) {
    match value {
        Value::String(text) => {
            if text.contains('\0') {
                *text = text.replace('\0', "\u{fffd}");
            }
        }
        Value::Array(values) => values.iter_mut().for_each(replace_nul),
        Value::Object(fields) => {
            *fields = std::mem::take(fields)
                .into_iter()
                .map(|(key, mut value)| {
                    replace_nul(&mut value);
                    (key.replace('\0', "\u{fffd}"), value)
                })
                .collect();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_original_when_projected_keys_collide() {
        let original = json!({"a\0": ["U\0", "\\u0000", "\u{fffd}"], "a\u{fffd}": 2});
        let encoded = encode(original.clone());
        assert!(!contains_nul(&encoded["record"]));
        assert_eq!(
            serde_json::from_str::<Value>(encoded["original"].as_str().unwrap()).unwrap(),
            original
        );
    }

    #[test]
    fn ordinary_events_need_no_original_copy() {
        let original = json!({"data": "\\u0000\r\n\t\u{1b} 中文 🦀 \u{fffd}"});
        assert_eq!(
            encode(original.clone()),
            json!({"record": original, "original": null})
        );
    }
}
