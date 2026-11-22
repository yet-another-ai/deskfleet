//! Android sends Linux evdev scan codes for physical keyboards. Committed IME
//! text and hardware/virtual chords use the same viewer queue as pointer input.
#![allow(unsafe_code)] // JNI exports match the static methods on DeskFleetBridge.

use deskfleet_input::{InputEvent, NativeKeyCode};
use jni::objects::{JClass, JString};
use jni::strings::JNIString;
use jni::sys::{jint, jstring};
use jni::{EnvUnowned, jni_str};

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativePhysicalKeyCode<
    'local,
>(
    mut env: EnvUnowned<'local>,
    _class: JClass<'local>,
    scan: jint,
) -> jstring {
    env.with_env(|env| -> Result<jstring, jni::errors::Error> {
        let Some(code) = u32::try_from(scan)
            .ok()
            .and_then(|scan| NativeKeyCode::Evdev(scan).code())
        else {
            return Ok(std::ptr::null_mut());
        };
        Ok(JString::from_str(env, code)?.into_raw())
    })
    .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativeInputSequence<
    'local,
>(
    mut env: EnvUnowned<'local>,
    _class: JClass<'local>,
    sequence: JString<'local>,
) {
    env.with_env(|env| -> Result<(), jni::errors::Error> {
        match serde_json::from_str::<Vec<InputEvent>>(&sequence.to_string()) {
            Ok(events) => crate::android::send_view_input(events),
            Err(error) => env.throw_new(
                jni_str!("java/lang/IllegalArgumentException"),
                JNIString::from(error.to_string()),
            )?,
        }
        Ok(())
    })
    .resolve::<jni::errors::ThrowRuntimeExAndDefault>();
}
