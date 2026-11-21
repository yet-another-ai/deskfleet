//! Per-view NSH root binding. The Android activity retains platform input and video ownership.
//!
//! SAFETY: Exported JNI names/signatures match DeskFleetBridge and NSH Native declarations.
//! NshView owns each native handle; Android detaches its bridge before destroying that view.

#![allow(unsafe_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use jni::objects::{JClass, JObject, JString, JValue};
use jni::strings::JNIString;
use jni::sys::jlong;
use jni::{EnvUnowned, jni_sig, jni_str};
use tokio::sync::watch;

use crate::nsh_controls::{ControlsBridge, ToolbarState, controls_root};

struct ControlsHost {
    state: watch::Sender<ToolbarState>,
    bridge: ControlsBridge,
    alive: Arc<AtomicBool>,
}

static HOSTS: OnceLock<Mutex<HashMap<jlong, ControlsHost>>> = OnceLock::new();

fn hosts() -> &'static Mutex<HashMap<jlong, ControlsHost>> {
    HOSTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Installs the bridge before NshView.runRustApp starts this view's engine.
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativeAttachControls<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    view: JObject<'local>,
    callback: JObject<'local>,
    state_json: JString<'local>,
) -> jlong {
    unowned_env
        .with_env(|env| -> Result<jlong, jni::errors::Error> {
            let handle = env
                .get_field(&view, jni_str!("handle"), jni_sig!("J"))?
                .j()?;
            let initial = match serde_json::from_str::<ToolbarState>(&state_json.to_string()) {
                Ok(state) => state,
                Err(error) => {
                    env.throw_new(
                        jni_str!("java/lang/IllegalArgumentException"),
                        JNIString::from(error.to_string()),
                    )?;
                    return Ok(0);
                }
            };
            let vm = env.get_java_vm()?;
            let callback = env.new_global_ref(callback)?;
            let alive = Arc::new(AtomicBool::new(true));
            let callback_alive = Arc::clone(&alive);
            let (state, bridge) = ControlsBridge::new(initial, move |action| {
                if !callback_alive.load(Ordering::Acquire) {
                    return;
                }
                let Ok(payload) = serde_json::to_string(&action) else {
                    return;
                };
                if let Err(error) =
                    vm.attach_current_thread(|env| -> Result<(), jni::errors::Error> {
                        let value = JString::from_str(env, &payload)?;
                        env.call_method(
                            &callback,
                            jni_str!("onControlsAction"),
                            jni_sig!("(Ljava/lang/String;)V"),
                            &[JValue::Object(value.as_ref())],
                        )?;
                        Ok(())
                    })
                {
                    tracing::error!(%error, "Android viewer controls callback failed");
                }
            });
            if let Ok(mut hosts) = hosts().lock()
                && let Some(previous) = hosts.insert(
                    handle,
                    ControlsHost {
                        state,
                        bridge,
                        alive,
                    },
                )
            {
                previous.alive.store(false, Ordering::Release);
            }
            Ok(handle)
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

/// NshView's standard Rust entry, with the bridge for its own native handle.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_longbridge_nsh_Native_runRust<'local>(
    _unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
) {
    let bridge = hosts()
        .lock()
        .ok()
        .and_then(|hosts| hosts.get(&handle).map(|host| host.bridge.clone()));
    if let Some(bridge) = bridge {
        nsh_android_platform::run_root(handle, controls_root(bridge));
    } else {
        tracing::error!(handle, "Android viewer controls started without a bridge");
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativeUpdateControls<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
    state_json: JString<'local>,
) {
    unowned_env
        .with_env(|env| -> Result<(), jni::errors::Error> {
            let state = match serde_json::from_str::<ToolbarState>(&state_json.to_string()) {
                Ok(state) => state,
                Err(error) => {
                    env.throw_new(
                        jni_str!("java/lang/IllegalArgumentException"),
                        JNIString::from(error.to_string()),
                    )?;
                    return Ok(());
                }
            };
            if let Ok(hosts) = hosts().lock()
                && let Some(host) = hosts.get(&handle)
            {
                host.state.send_if_modified(|current| {
                    if *current == state {
                        return false;
                    }
                    *current = state;
                    true
                });
            }
            Ok(())
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>();
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativeDetachControls<
    'local,
>(
    _unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
) {
    if let Ok(mut hosts) = hosts().lock()
        && let Some(host) = hosts.remove(&handle)
    {
        host.alive.store(false, Ordering::Release);
    }
}
