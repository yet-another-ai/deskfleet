use super::*;
use crate::protocol::UiState;
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
        state.panel = Some(Panel::Control);
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
    assert!(labels(&mounted).contains(&"Control · Paused".to_string()));
}

fn labels(mount: &nsh_core::MountBatch) -> Vec<String> {
    mount
        .items
        .iter()
        .filter_map(|item| match item {
            MountItem::AccessibilityLabel {
                label: Some(label), ..
            } => Some(label.to_string()),
            MountItem::ViewProps { props, .. } => props
                .accessibility
                .label
                .as_ref()
                .map(|label| label.to_string()),
            _ => None,
        })
        .collect()
}

fn find(mount: &nsh_core::MountBatch, wanted: &str) -> Option<nsh_core::NodeId> {
    mount.items.iter().find_map(|item| match item {
        MountItem::AccessibilityLabel {
            id,
            label: Some(label),
        } if label.as_ref() == wanted => Some(*id),
        MountItem::ViewProps { id, props }
            if props.accessibility.label.as_deref() == Some(wanted) =>
        {
            Some(*id)
        }
        _ => None,
    })
}

/// Mounts one root and returns the first mount and every action it emits.
fn mount(
    state: ToolbarState,
) -> (
    Core<ApproxTextEngine>,
    nsh_core::MountBatch,
    Arc<Mutex<Vec<ToolbarAction>>>,
) {
    let actions = Arc::new(Mutex::new(Vec::new()));
    let output = actions.clone();
    let (_sender, bridge) =
        ControlsBridge::new(state, move |action| output.lock().unwrap().push(action));
    let mut core = Core::new(ApproxTextEngine, size(px(390.), px(720.)));
    core.mount_root(&controls_root(bridge));
    let mounted = core.commit().expect("controls mounted");
    (core, mounted, actions)
}

fn press(core: &mut Core<ApproxTextEngine>, mount: &nsh_core::MountBatch, wanted: &str) {
    let id = find(mount, wanted).unwrap_or_else(|| panic!("{wanted} is rendered"));
    assert!(core.component_event(
        id,
        EventKind::Press,
        &EventPayload::Press(PressEvent::default())
    ));
}

#[test]
fn the_bar_holds_only_the_three_panel_triggers() {
    let (mut core, mounted, actions) = mount(connected(false));
    let shown = labels(&mounted);
    for wanted in [
        "Control",
        "Config",
        "Monitor · Waiting for video · —",
        "Full screen",
    ] {
        assert!(shown.contains(&wanted.to_string()), "{wanted} in {shown:?}");
    }
    for hidden in [
        "Disconnect",
        "Hacker Keyboard",
        "Mouse and keyboard control",
    ] {
        assert!(
            find(&mounted, hidden).is_none(),
            "{hidden} stays in a panel"
        );
    }
    press(&mut core, &mounted, "Config");
    assert_eq!(
        *actions.lock().unwrap(),
        [ToolbarAction::TogglePanel(Panel::Config)]
    );
}

#[test]
fn each_panel_owns_its_features() {
    let mut state = connected(true);
    state.panel = Some(Panel::Control);
    let shown = labels(&mount(state.clone()).1);
    for wanted in [
        "Send input",
        "Direct",
        "Trackpad",
        "Pinch to zoom",
        "System keyboard",
        "Hacker Keyboard",
        "Clipboard sharing",
    ] {
        assert!(shown.contains(&wanted.to_string()), "{wanted} in {shown:?}");
    }
    state.panel = Some(Panel::Config);
    let shown = labels(&mount(state.clone()).1);
    for wanted in [
        "Mouse and keyboard control",
        "Reconnect",
        "Disconnect",
        "Close viewer",
    ] {
        assert!(shown.contains(&wanted.to_string()), "{wanted} in {shown:?}");
    }
    assert!(!shown.contains(&"Send input".to_string()));
    state.panel = Some(Panel::Monitor);
    let (_, mounted, _) = mount(state.clone());
    assert!(labels(&mounted).contains(&"Monitor".to_string()));
    state.ui.status = Status::Disconnected;
    assert!(find(&mount(state).1, "Close panel").is_none());
}

#[test]
fn view_only_sessions_offer_to_allow_control() {
    let mut state = connected(false);
    state.ui.control = false;
    state.panel = Some(Panel::Control);
    let (mut core, mounted, actions) = mount(state);
    assert!(labels(&mounted).contains(&"Control · View only".to_string()));
    assert!(find(&mounted, "Send input").is_none());
    press(&mut core, &mounted, "Allow control");
    assert_eq!(*actions.lock().unwrap(), [ToolbarAction::SetControl(true)]);
}

#[test]
fn shortcut_chips_follow_the_remote_platform() {
    let mut state = connected(false);
    state.ui.platform = Some("win32".into());
    state.ui.secure_attention = true;
    state.panel = Some(Panel::Control);
    let (mut core, mounted, actions) = mount(state);
    press(&mut core, &mounted, "Ctrl Shift Esc");
    press(&mut core, &mounted, "Send Ctrl+Alt+Del");
    assert_eq!(
        *actions.lock().unwrap(),
        [
            ToolbarAction::Shortcut(&["ControlLeft", "ShiftLeft", "Escape"]),
            ToolbarAction::SecureAttention,
        ]
    );
    assert!(
        input::shortcuts(Some("darwin"))
            .iter()
            .all(|(title, codes)| { !codes.is_empty() && !title.is_empty() })
    );
}

#[test]
fn panel_contract_and_bitrate_formatting() {
    assert_eq!(
        serde_json::to_value(ToolbarAction::TogglePanel(Panel::Monitor)).unwrap(),
        serde_json::json!({"type":"togglePanel","value":"monitor"})
    );
    assert_eq!(
        serde_json::to_value(ToolbarAction::Shortcut(&["AltLeft", "Tab"])).unwrap(),
        serde_json::json!({"type":"shortcut","value":["AltLeft","Tab"]})
    );
    let state: ToolbarState =
        serde_json::from_value(serde_json::json!({"panel":"config","pinchZoom":false})).unwrap();
    assert_eq!(state.panel, Some(Panel::Config));
    assert!(!state.pinch_zoom);
    assert!(ToolbarState::default().pinch_zoom);
    assert_eq!(monitor::bitrate(4_240_000), ("4.2".into(), "Mbps"));
    assert_eq!(monitor::bitrate(812_400), ("812".into(), "kbps"));
}

#[test]
fn toolbar_toggles_between_expanded_and_collapsed_controls() {
    for mobile in [false, true] {
        let mut state = connected(mobile);
        let expanded = labels(&mount(state.clone()).1);
        assert!(expanded.contains(&"Collapse controls".to_string()));
        assert!(!expanded.contains(&"Expand controls".to_string()));
        for wanted in ["Control", "Config", "Monitor · Waiting for video · —"] {
            assert!(
                expanded.contains(&wanted.to_string()),
                "{wanted} in {expanded:?}"
            );
        }
        assert_eq!(expanded.contains(&"Full screen".to_string()), !mobile);

        state.collapsed = true;
        state.panel = Some(Panel::Config);
        state.fullscreen = true;
        let collapsed = labels(&mount(state).1);
        assert!(collapsed.contains(&"Expand controls".to_string()));
        assert!(!collapsed.contains(&"Collapse controls".to_string()));
        for hidden in [
            "Control",
            "Config",
            "Monitor · Waiting for video · —",
            "Full screen",
            "Exit full screen",
            "Close panel",
        ] {
            assert!(
                !collapsed.contains(&hidden.to_string()),
                "{hidden} hidden in {collapsed:?}"
            );
        }
    }
}
