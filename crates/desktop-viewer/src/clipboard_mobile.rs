//! Android JNI clipboard requests.

use serde::Deserialize;

use crate::clipboard::{ClipboardIntent, ClipboardPolicy};

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Request {
    Reset,
    Local {
        intent: ClipboardIntent,
        input_enabled: bool,
        sharing: bool,
        text: Option<String>,
    },
    Remote {
        input_enabled: bool,
        sharing: bool,
        text: String,
    },
}

pub(crate) fn update(
    policy: &mut ClipboardPolicy,
    json: &str,
) -> Result<Option<String>, serde_json::Error> {
    Ok(match serde_json::from_str::<Request>(json)? {
        Request::Reset => {
            policy.reset_session();
            None
        }
        Request::Local {
            intent,
            input_enabled,
            sharing,
            text,
        } => policy.local(intent, input_enabled, sharing, text.as_deref()),
        Request::Remote {
            input_enabled,
            sharing,
            text,
        } => policy.remote(input_enabled, sharing, &text),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_contract_preserves_nuls_unicode_and_explicit_permissions() {
        let mut policy = ClipboardPolicy::default();
        let request = r#"{"operation":"local","intent":"explicit","inputEnabled":true,"sharing":false,"text":"你好\u0000\n\"✓\""}"#;
        assert_eq!(
            update(&mut policy, request).unwrap().as_deref(),
            Some("你好\n\"✓\"")
        );
        assert_eq!(update(&mut policy, request).unwrap(), None);
        update(&mut policy, r#"{"operation":"reset"}"#).unwrap();
        assert!(update(&mut policy, request).unwrap().is_some());
    }

    #[test]
    fn invalid_requests_do_not_change_policy() {
        let mut policy = ClipboardPolicy::default();
        for request in [
            "invalid",
            r#"{"operation":"local","intent":"explicit","text":"secret"}"#,
            r#"{"operation":"remote","inputEnabled":true,"text":"secret"}"#,
            r#"{"operation":"local","intent":"unknown","inputEnabled":true,"sharing":true}"#,
        ] {
            assert!(update(&mut policy, request).is_err());
        }
        let request = r#"{"operation":"local","intent":"focus","inputEnabled":true,"sharing":true,"text":"secret"}"#;
        assert_eq!(update(&mut policy, request).unwrap(), None);
    }

    #[test]
    fn mobile_remote_writes_do_not_echo() {
        let mut policy = ClipboardPolicy::default();
        let remote = r#"{"operation":"remote","inputEnabled":true,"sharing":true,"text":"remote"}"#;
        assert_eq!(
            update(&mut policy, remote).unwrap().as_deref(),
            Some("remote")
        );
        assert_eq!(update(&mut policy, remote).unwrap(), None);
        let local = r#"{"operation":"local","intent":"changed","inputEnabled":true,"sharing":true,"text":"remote"}"#;
        assert_eq!(update(&mut policy, local).unwrap(), None);
    }
}
