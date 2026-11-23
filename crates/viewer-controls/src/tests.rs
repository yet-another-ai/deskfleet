use super::*;
use serde_json::{Value, json};

fn window(mobile: bool) -> Value {
    json!({
        "mobile": mobile,
        "ui": { "status": "connected", "control": true, "inputReady": true, "secureAttention": false }
    })
}

/// Exercise the same synchronous interface as both mobile adapters, including
/// deserialization of the NSH action and the exact effect payload the hosts see.
fn effects(state: &Value, action: ToolbarAction) -> Value {
    let expected = serde_json::from_value::<ControlState>(state.clone())
        .unwrap()
        .effects(&action);
    let result =
        ViewerControls::effects(state.to_string(), serde_json::to_string(&action).unwrap())
            .unwrap();
    let result: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(result, serde_json::to_value(expected).unwrap());
    result
}

#[test]
fn pause_clears_held_input_and_resume_requires_a_ready_peer() {
    for mobile in [false, true] {
        let mut state = window(mobile);
        state["modifiers"] = json!([true, false, false, false]);
        assert_eq!(
            effects(&state, ToolbarAction::ToggleControl),
            json!([
                {"type":"release","value":false}, {"type":"paused","value":true},
                {"type":"hackerOpen","value":false}, {"type":"keyboard","value":false}
            ])
        );
        state["paused"] = json!(true);
        assert_eq!(effects(&state, ToolbarAction::Key("Tab")), json!([]));
        assert_eq!(effects(&state, ToolbarAction::SyncClipboard), json!([]));
        assert_eq!(
            effects(&state, ToolbarAction::ToggleControl),
            json!([
                {"type":"release","value":false}, {"type":"paused","value":false}
            ])
        );
        state["ui"]["inputReady"] = json!(false);
        assert_eq!(effects(&state, ToolbarAction::ToggleControl), json!([]));
        assert_eq!(
            effects(
                &state,
                ToolbarAction::SessionChanged {
                    was_enabled: false,
                    display_changed: false
                }
            ),
            json!([{"type":"paused","value":false}])
        );
        assert_eq!(effects(&state, ToolbarAction::Key("Tab")), json!([]));
    }
}

#[test]
fn drag_lock_and_display_changes_release_before_addressing_the_next_display() {
    let mut state = window(true);
    assert_eq!(
        effects(&state, ToolbarAction::ToggleDrag),
        json!([
            {"type":"release","value":false}, {"type":"relativeMouse","value":true},
            {"type":"resetPointer"}, {"type":"dragButton","value":true}
        ])
    );
    state["dragging"] = json!(true);
    state["relativeMouse"] = json!(true);
    assert_eq!(
        effects(&state, ToolbarAction::ToggleDrag),
        json!([{"type":"dragButton","value":false}])
    );
    assert_eq!(
        effects(&state, ToolbarAction::SelectDisplay(3)),
        json!([
            {"type":"release","value":false}, {"type":"emit","value":{"type":"selectDisplay","displayId":3}}
        ])
    );
    assert_eq!(
        effects(
            &state,
            ToolbarAction::SessionChanged {
                was_enabled: true,
                display_changed: true
            }
        ),
        json!([{"type":"release","value":false}, {"type":"keyboard","value":false},
               {"type":"hackerOpen","value":false}, {"type":"resetPointer"}])
    );
}

#[test]
fn ime_keeps_selected_modifiers_and_the_next_toolbar_key_consumes_them_in_order() {
    let mut state = window(true);
    for code in ["MetaLeft", "ControlLeft", "AltLeft"] {
        let result = effects(&state, ToolbarAction::ToggleModifier(code));
        assert_eq!(result[0]["type"], "modifiers");
        state["modifiers"] = result[0]["value"].clone();
    }
    assert_eq!(
        effects(&state, ToolbarAction::ToggleKeyboard),
        json!([
            {"type":"release","value":true}, {"type":"keyboard","value":true}
        ])
    );
    let result = effects(&state, ToolbarAction::Key("Delete"));
    assert_eq!(
        result,
        json!([{"type":"modifiers","value":[false,false,false,false]},
        {"type":"chord","value":["ControlLeft","AltLeft","MetaLeft","Delete"]}])
    );
    state["modifiers"] = result[0]["value"].clone();
    assert_eq!(
        effects(&state, ToolbarAction::Key("Tab"))[1]["value"],
        json!(["Tab"])
    );
}

#[test]
fn queued_actions_use_the_current_capabilities_and_local_zoom_still_works_view_only() {
    let mut state = window(true);
    assert_eq!(effects(&state, ToolbarAction::SecureAttention), json!([]));
    state["ui"]["secureAttention"] = json!(true);
    assert_eq!(
        effects(&state, ToolbarAction::SecureAttention),
        json!([{"type":"secureAttention"}])
    );
    state["ui"]["control"] = json!(false);
    for action in [
        ToolbarAction::SecureAttention,
        ToolbarAction::ToggleDrag,
        ToolbarAction::Shortcut(&["AltLeft", "Tab"]),
        ToolbarAction::ToggleModifier("ShiftLeft"),
    ] {
        assert_eq!(effects(&state, action), json!([]));
    }
    assert_eq!(
        effects(&state, ToolbarAction::SetPinchZoom(false)),
        json!([
            {"type":"pinchZoom","value":false},{"type":"resetZoom"}
        ])
    );
    assert_eq!(
        effects(&state, ToolbarAction::SetControl(true))[1],
        json!({"type":"emit","value":{"type":"setControl","control":true}})
    );
}

#[test]
fn nshm_registers_the_viewer_module() {
    assert!(
        registry()
            .module_specs()
            .iter()
            .any(|module| module.name == "ViewerControls")
    );
    assert!(ViewerControls::effects("{}".into(), "{}".into()).is_err());
}
