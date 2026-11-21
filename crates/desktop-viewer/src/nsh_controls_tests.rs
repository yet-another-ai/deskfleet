use super::*;
use nsh_core::{ApproxTextEngine, Core, EventKind, EventPayload, MountItem, PressEvent};
use std::sync::Mutex;

fn connected(mobile: bool) -> ToolbarState {
    ToolbarState {
        mobile,
        ui: UiState {
            status: Status::Connected,
            control: true,
            input_ready: true,
            ..UiState::default()
        },
        viewport: (390., 720.),
        ..ToolbarState::default()
    }
}

#[test]
fn native_snapshots_and_actions_use_the_same_json_contract() {
    let state: ToolbarState = serde_json::from_value(serde_json::json!({
        "mobile": true, "relativeMouse": true, "hackerOpen": true,
        "modifiers": [true, false, true, false], "viewport": [390, 720]
    }))
    .unwrap();
    assert!(state.mobile && state.relative_mouse && state.hacker_open);
    assert!(!state.controls_enabled());
    assert_eq!(state.modifiers, [true, false, true, false]);
    assert_eq!(
        serde_json::to_value(ToolbarAction::Key("Tab")).unwrap(),
        serde_json::json!({"type":"key","value":"Tab"})
    );
    assert_eq!(
        serde_json::to_value(ToolbarAction::Measured(320., 50.)).unwrap(),
        serde_json::json!({"type":"measured","value":[320.,50.]})
    );
}

#[test]
fn explicit_theme_overrides_each_native_hosts_system_appearance() {
    let mut state = connected(true);
    state.dark = true;
    assert!(state.dark());
    state.ui.theme = Some("light".into());
    assert!(!state.dark());
    state.dark = false;
    state.ui.theme = Some("dark".into());
    assert!(state.dark());
}

#[test]
fn controls_require_connected_acknowledged_unpaused_control() {
    let mut state = connected(true);
    assert!(state.controls_enabled());
    state.paused = true;
    assert!(!state.controls_enabled());
    state.paused = false;
    state.ui.input_ready = false;
    assert!(!state.controls_enabled());
    state.ui.input_ready = true;
    state.ui.control = false;
    assert!(!state.controls_enabled());
    state.ui.control = true;
    state.ui.status = Status::Disconnected;
    assert!(!state.controls_enabled());
}

#[test]
fn mobile_and_desktop_roots_render_the_same_keyboard_and_keep_callbacks_local() {
    for mobile in [false, true] {
        let actions = Arc::new(Mutex::new(Vec::new()));
        let output = actions.clone();
        let mut state = connected(mobile);
        state.hacker_open = true;
        let (_sender, bridge) =
            ControlsBridge::new(state, move |action| output.lock().unwrap().push(action));
        let mut core = Core::new(ApproxTextEngine, size(px(390.), px(720.)));
        core.mount_root(&controls_root(bridge));
        let mount = core.commit().expect("shared controls mounted");
        let key = mount
            .items
            .iter()
            .find_map(|item| match item {
                MountItem::AccessibilityLabel {
                    id,
                    label: Some(label),
                } if label.as_ref() == "Tab" => Some(*id),
                MountItem::ViewProps { id, props }
                    if props.accessibility.label.as_deref() == Some("Tab") =>
                {
                    Some(*id)
                }
                _ => None,
            })
            .expect("same Hacker Keyboard key in either host");
        assert!(core.component_event(
            key,
            EventKind::Press,
            &EventPayload::Press(PressEvent::default())
        ));
        assert!(actions.lock().unwrap().contains(&ToolbarAction::Key("Tab")));
        let system_keyboard = mount.items.iter().any(|item| match item {
            MountItem::AccessibilityLabel {
                label: Some(label), ..
            } => label.as_ref() == "System keyboard",
            MountItem::ViewProps { props, .. } => {
                props.accessibility.label.as_deref() == Some("System keyboard")
            }
            _ => false,
        });
        assert_eq!(system_keyboard, mobile);
    }
}

#[test]
fn host_updates_reach_an_existing_root_without_replacing_its_bridge() {
    let (sender, bridge) = ControlsBridge::new(connected(true), |_| {});
    let mut core = Core::new(ApproxTextEngine, size(px(390.), px(720.)));
    core.mount_root(&controls_root(bridge));
    core.commit().expect("controls mounted");
    core.run_component_tasks();
    sender.send_modify(|state| state.hacker_open = true);
    core.run_component_tasks();
    let mounted = core
        .commit()
        .expect("keyboard opened from the host snapshot");
    assert!(
        mounted.items.iter().any(|item| matches!(item,
        MountItem::ViewProps { props, .. } if props.accessibility.label.as_deref() == Some("Tab")))
    );
    sender.send_modify(|state| {
        state.hacker_open = false;
        state.paused = true;
    });
    core.run_component_tasks();
    let mounted = core.commit().expect("pause update rendered");
    assert!(mounted.items.iter().any(|item| match item {
        MountItem::ViewProps { props, .. } =>
            props.accessibility.label.as_deref() == Some("Resume control"),
        MountItem::AccessibilityLabel { label, .. } => label.as_deref() == Some("Resume control"),
        _ => false,
    }));
}
