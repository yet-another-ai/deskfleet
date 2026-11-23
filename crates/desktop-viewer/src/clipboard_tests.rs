use super::*;

fn local(policy: &mut ClipboardPolicy, intent: ClipboardIntent, text: &str) -> Option<String> {
    policy.local(intent, true, true, Some(text))
}

#[test]
fn sanitizes_before_enforcing_the_utf8_limit_in_both_directions() {
    let boundary = format!("{}é", "a".repeat(MAX_CLIPBOARD_BYTES - 2));
    let padded = format!("\0{boundary}\0");
    assert_eq!(sanitize(&padded), Some(boundary.clone()));
    assert_eq!(sanitize(&format!("{boundary}é")), None);
    for text in ["", "\0", "\0\0"] {
        assert_eq!(sanitize(text), None);
    }
    let mut outgoing = ClipboardPolicy::default();
    let mut incoming = ClipboardPolicy::default();
    assert_eq!(
        local(&mut outgoing, ClipboardIntent::Explicit, &padded),
        Some(boundary.clone())
    );
    assert_eq!(incoming.remote(true, true, &padded), Some(boundary));
    assert_eq!(
        sanitize("\0hello\t\r\n你好👋\0"),
        Some("hello\t\r\n你好👋".into())
    );
}

#[test]
fn initial_focus_never_sends_but_paste_can_send_the_opening_baseline() {
    let mut policy = ClipboardPolicy::default();
    assert_eq!(local(&mut policy, ClipboardIntent::Focus, "initial"), None);
    assert_eq!(local(&mut policy, ClipboardIntent::Focus, "initial"), None);
    assert_eq!(
        local(&mut policy, ClipboardIntent::Paste, "initial"),
        Some("initial".into())
    );
    assert_eq!(local(&mut policy, ClipboardIntent::Paste, "initial"), None);
    assert_eq!(
        local(&mut policy, ClipboardIntent::Focus, "new"),
        Some("new".into())
    );
    assert_eq!(local(&mut policy, ClipboardIntent::Focus, "new"), None);
}

#[test]
fn empty_initial_focus_still_establishes_a_baseline() {
    let mut policy = ClipboardPolicy::default();
    assert_eq!(
        policy.local(ClipboardIntent::Focus, false, false, None),
        None
    );
    assert_eq!(
        local(&mut policy, ClipboardIntent::Focus, "new"),
        Some("new".into())
    );
}

#[test]
fn desktop_can_seed_the_baseline_before_the_first_focus() {
    let mut policy = ClipboardPolicy::default();
    policy.seed_baseline(Some("initial\0"));
    assert_eq!(local(&mut policy, ClipboardIntent::Focus, "initial"), None);
    assert_eq!(
        local(&mut policy, ClipboardIntent::Focus, "copied outside"),
        Some("copied outside".into())
    );
}

#[test]
fn explicit_bypasses_sharing_but_no_operation_bypasses_input_permission() {
    for intent in [
        ClipboardIntent::Focus,
        ClipboardIntent::Changed,
        ClipboardIntent::Paste,
        ClipboardIntent::Explicit,
    ] {
        for enabled in [false, true] {
            for sharing in [false, true] {
                let mut policy = ClipboardPolicy::default();
                policy.seed_baseline(Some("baseline"));
                let expected = enabled && (sharing || intent == ClipboardIntent::Explicit);
                assert_eq!(
                    policy
                        .local(intent, enabled, sharing, Some("text"))
                        .is_some(),
                    expected,
                    "{intent:?} {enabled} {sharing}"
                );
                assert_eq!(
                    policy.remote(enabled, sharing, "remote").is_some(),
                    enabled && sharing
                );
            }
        }
    }
}

#[test]
fn explicit_and_changed_can_send_the_initial_baseline() {
    for intent in [ClipboardIntent::Explicit, ClipboardIntent::Changed] {
        let mut policy = ClipboardPolicy::default();
        policy.seed_baseline(Some("baseline"));
        assert_eq!(
            local(&mut policy, intent, "baseline"),
            Some("baseline".into())
        );
        assert_eq!(local(&mut policy, intent, "baseline"), None);
    }
}

#[test]
fn remote_text_and_local_echoes_are_deduplicated_after_sanitizing() {
    let mut policy = ClipboardPolicy::default();
    assert_eq!(policy.remote(true, true, "a\0b"), Some("ab".into()));
    assert_eq!(policy.remote(true, true, "ab"), None);
    for intent in [
        ClipboardIntent::Focus,
        ClipboardIntent::Changed,
        ClipboardIntent::Paste,
        ClipboardIntent::Explicit,
    ] {
        assert_eq!(local(&mut policy, intent, "ab\0"), None);
    }
    assert_eq!(
        local(&mut policy, ClipboardIntent::Changed, "local"),
        Some("local".into())
    );
    assert_eq!(policy.remote(true, true, "local"), None);
    assert_eq!(policy.remote(true, true, "ab"), Some("ab".into()));
}

#[test]
fn disabled_or_invalid_updates_do_not_poison_dedup_or_baseline() {
    let mut policy = ClipboardPolicy::default();
    policy.seed_baseline(Some("baseline"));
    assert_eq!(
        policy.local(ClipboardIntent::Changed, false, true, Some("new")),
        None
    );
    assert_eq!(policy.remote(true, false, "new"), None);
    for text in [
        String::new(),
        "\0".into(),
        "界".repeat(MAX_CLIPBOARD_BYTES / 3 + 1),
    ] {
        assert_eq!(local(&mut policy, ClipboardIntent::Changed, &text), None);
        assert_eq!(policy.remote(true, true, &text), None);
    }
    assert_eq!(local(&mut policy, ClipboardIntent::Focus, "baseline"), None);
    assert_eq!(
        local(&mut policy, ClipboardIntent::Focus, "new"),
        Some("new".into())
    );
}

#[test]
fn session_reset_discards_peer_history_and_requires_a_new_focus_baseline() {
    let mut policy = ClipboardPolicy::default();
    assert_eq!(
        policy.remote(true, true, "old peer"),
        Some("old peer".into())
    );
    policy.reset_session();
    assert_eq!(local(&mut policy, ClipboardIntent::Focus, "old peer"), None);
    assert_eq!(
        local(&mut policy, ClipboardIntent::Paste, "old peer"),
        Some("old peer".into())
    );
    policy.reset_session();
    assert_eq!(
        policy.remote(true, true, "old peer"),
        Some("old peer".into())
    );
}

#[test]
fn independent_viewers_do_not_share_clipboard_history() {
    let mut first = ClipboardPolicy::default();
    let mut second = ClipboardPolicy::default();
    assert_eq!(
        local(&mut first, ClipboardIntent::Explicit, "text"),
        Some("text".into())
    );
    assert_eq!(
        local(&mut second, ClipboardIntent::Explicit, "text"),
        Some("text".into())
    );
}

#[test]
fn identifies_only_paste_key_downs_and_non_primary_button_downs() {
    for code in ["KeyV", "Insert", "KeyA"] {
        for pressed in [false, true] {
            for repeat in [false, true] {
                assert_eq!(
                    is_paste_candidate(&InputEvent::Key {
                        code: code.into(),
                        pressed,
                        repeat
                    }),
                    pressed && !repeat && code != "KeyA"
                );
            }
        }
    }
    for button in 0..=2 {
        for pressed in [false, true] {
            assert_eq!(
                is_paste_candidate(&InputEvent::PointerButton {
                    button,
                    pressed,
                    x: 0.5,
                    y: 0.5
                }),
                pressed && button != 0
            );
        }
    }
    assert!(!is_paste_candidate(&InputEvent::ReleaseAll));
}
