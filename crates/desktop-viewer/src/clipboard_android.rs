//! JNI ownership for NativeClipboard. Kotlin serializes calls and closes once.
#![allow(unsafe_code)]

use jni::objects::{JClass, JString};
use jni::strings::JNIString;
use jni::sys::{jlong, jstring};
use jni::{EnvUnowned, jni_str};

use crate::clipboard::ClipboardPolicy;

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_NativeClipboard_nativeCreate(
    _env: EnvUnowned<'_>,
    _class: JClass<'_>,
) -> jlong {
    Box::into_raw(Box::new(ClipboardPolicy::default())) as jlong
}

/// # Safety
/// NativeClipboard passes its live create handle under its synchronized lock.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_NativeClipboard_nativeUpdate<
    'local,
>(
    mut env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
    request: JString<'local>,
) -> jstring {
    env.with_env(|env| -> Result<jstring, jni::errors::Error> {
        // SAFETY: The synchronized Kotlin owner retains this unique live Box.
        let policy = unsafe { &mut *(handle as *mut ClipboardPolicy) };
        match crate::clipboard_mobile::update(policy, &request.to_string()) {
            Ok(Some(text)) => Ok(JString::from_str(env, text)?.into_raw()),
            Ok(None) => Ok(std::ptr::null_mut()),
            Err(error) => {
                env.throw_new(
                    jni_str!("java/lang/IllegalArgumentException"),
                    JNIString::from(error.to_string()),
                )?;
                Ok(std::ptr::null_mut())
            }
        }
    })
    .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

/// # Safety
/// NativeClipboard transfers its live create handle exactly once under its lock.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_NativeClipboard_nativeDestroy(
    _env: EnvUnowned<'_>,
    _class: JClass<'_>,
    handle: jlong,
) {
    // SAFETY: close clears the Kotlin handle before releasing this allocation.
    drop(unsafe { Box::from_raw(handle as *mut ClipboardPolicy) });
}
