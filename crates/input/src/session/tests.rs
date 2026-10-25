use std::cell::RefCell;
use std::rc::Rc;

use super::*;
use crate::InputError;

#[derive(Clone, Default)]
struct Fake {
    events: Rc<RefCell<Vec<String>>>,
    fail_release: Rc<RefCell<bool>>,
}

impl Backend for Fake {
    fn move_pointer(&mut self, x: f64, y: f64) -> Result<()> {
        self.events.borrow_mut().push(format!("move {x} {y}"));
        Ok(())
    }
    fn button(&mut self, button: u8, pressed: bool) -> Result<()> {
        self.events
            .borrow_mut()
            .push(format!("button {button} {pressed}"));
        Ok(())
    }
    fn wheel(&mut self, dx: f64, dy: f64) -> Result<()> {
        self.events.borrow_mut().push(format!("wheel {dx} {dy}"));
        Ok(())
    }
    fn key(&mut self, code: &str, pressed: bool, repeat: bool) -> Result<()> {
        if code == "Unsupported" {
            return Err(InputError::Unsupported("key"));
        }
        self.events
            .borrow_mut()
            .push(format!("key {code} {pressed} {repeat}"));
        if !pressed && *self.fail_release.borrow() {
            return Err(InputError::Platform("release failed".into()));
        }
        Ok(())
    }
}

fn key(code: &str, pressed: bool, repeat: bool) -> InputEvent {
    InputEvent::Key {
        code: code.into(),
        pressed,
        repeat,
    }
}

#[test]
fn blur_releases_only_remote_inputs_and_ignores_late_repeats() {
    let fake = Fake::default();
    let mut controller = Controller::new(fake.clone());
    controller.handle(key("ShiftLeft", false, false)).unwrap();
    controller.handle(key("ControlLeft", true, false)).unwrap();
    controller.handle(key("KeyA", true, false)).unwrap();
    controller.handle(key("KeyA", true, false)).unwrap();
    controller.handle(key("KeyA", true, true)).unwrap();
    controller.handle(InputEvent::ReleaseAll).unwrap();
    controller.handle(key("KeyA", true, true)).unwrap();
    controller.handle(key("KeyA", false, false)).unwrap();
    controller.release_all().unwrap();
    assert_eq!(
        *fake.events.borrow(),
        [
            "key ControlLeft true false",
            "key KeyA true false",
            "key KeyA true true",
            "key KeyA false false",
            "key ControlLeft false false",
        ]
    );
}

#[test]
fn click_carries_its_position_and_drop_ends_drag() {
    let fake = Fake::default();
    {
        let mut controller = Controller::new(fake.clone());
        controller
            .handle(InputEvent::PointerButton {
                button: 0,
                pressed: true,
                x: 0.25,
                y: 0.75,
            })
            .unwrap();
        controller
            .handle(InputEvent::PointerMove { x: 0.5, y: 0.5 })
            .unwrap();
    }
    assert_eq!(
        *fake.events.borrow(),
        [
            "move 0.25 0.75",
            "button 0 true",
            "move 0.5 0.5",
            "button 0 false",
        ]
    );
}

#[test]
fn malformed_input_releases_pressed_keys_without_injecting_coordinates() {
    for event in [
        InputEvent::PointerMove {
            x: f64::NAN,
            y: 0.5,
        },
        InputEvent::PointerMove { x: 0.5, y: -0.01 },
        InputEvent::Wheel {
            delta_x: 0.0,
            delta_y: f64::INFINITY,
        },
        InputEvent::Wheel {
            delta_x: 10_001.0,
            delta_y: 0.0,
        },
        InputEvent::PointerButton {
            button: 5,
            pressed: true,
            x: 0.5,
            y: 0.5,
        },
        key("Unsupported", true, false),
    ] {
        let fake = Fake::default();
        let mut controller = Controller::new(fake.clone());
        controller.handle(key("AltLeft", true, false)).unwrap();
        assert!(controller.handle(event).is_err());
        assert_eq!(
            *fake.events.borrow(),
            ["key AltLeft true false", "key AltLeft false false"]
        );
    }
}

#[test]
fn cleanup_attempts_all_keys_and_buttons_and_retries_failed_releases() {
    let fake = Fake::default();
    let mut controller = Controller::new(fake.clone());
    controller.handle(key("ControlLeft", true, false)).unwrap();
    controller.handle(key("KeyC", true, false)).unwrap();
    controller
        .handle(InputEvent::PointerButton {
            button: 2,
            pressed: true,
            x: 0.0,
            y: 1.0,
        })
        .unwrap();
    *fake.fail_release.borrow_mut() = true;
    assert!(controller.release_all().is_err());
    assert_eq!(controller.keys, ["ControlLeft", "KeyC"]);
    assert!(controller.buttons.is_empty());
    *fake.fail_release.borrow_mut() = false;
    controller.release_all().unwrap();
    assert!(controller.keys.is_empty());
    assert_eq!(
        &fake.events.borrow()[4..],
        [
            "key KeyC false false",
            "key ControlLeft false false",
            "button 2 false",
            "key KeyC false false",
            "key ControlLeft false false",
        ]
    );
}

#[test]
fn wire_contract_rejects_extra_fields_and_uses_physical_keys() {
    assert_eq!(
        serde_json::from_str::<InputEvent>(r#"{"type":"key","code":"KeyZ","pressed":true}"#)
            .unwrap(),
        key("KeyZ", true, false)
    );
    assert_eq!(
        serde_json::from_str::<InputEvent>(r#"{"type":"wheel","deltaX":2.5,"deltaY":-4}"#).unwrap(),
        InputEvent::Wheel {
            delta_x: 2.5,
            delta_y: -4.0
        }
    );
    assert!(
        serde_json::from_str::<InputEvent>(
            r#"{"type":"key","code":"KeyA","pressed":true,"displayId":99}"#
        )
        .is_err()
    );
    assert!(
        serde_json::from_str::<InputEvent>(
            r#"{"type":"pointerButton","button":-1,"pressed":true,"x":0,"y":0}"#
        )
        .is_err()
    );
}

#[test]
fn exclusive_lease_is_reusable_after_drop() {
    let lease = crate::ControlLease::acquire().unwrap();
    assert!(matches!(
        crate::ControlLease::acquire(),
        Err(InputError::Busy)
    ));
    drop(lease);
    assert!(crate::ControlLease::acquire().is_ok());
}
