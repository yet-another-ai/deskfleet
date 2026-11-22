//! Compose one Android viewer on the activity's UI thread. The activity supplies
//! its IME editor and hit-tested NSH overlay and retains the surface callbacks.

#![allow(unsafe_code)] // JNI export called by DeskFleetBridge.nativeMountViewer.

use jni::objects::{JClass, JObject, JValue};
use jni::sys::{jdouble, jint, jobject};
use jni::{EnvUnowned, jni_sig, jni_str};

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativeMountViewer<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    activity: JObject<'local>,
    keyboard: JObject<'local>,
    overlay: JObject<'local>,
) -> jobject {
    unowned_env
        .with_env(|env| -> Result<jobject, jni::errors::Error> {
            let context = &[JValue::Object(&activity)];
            let root = env.new_object(
                jni_str!("android/widget/FrameLayout"),
                jni_sig!("(Landroid/content/Context;)V"),
                context,
            )?;
            env.call_method(
                &root,
                jni_str!("setBackgroundColor"),
                jni_sig!("(I)V"),
                &[JValue::Int(i32::from_be_bytes([255, 0, 0, 0]))],
            )?;
            let surface = env.new_object(
                jni_str!("android/view/SurfaceView"),
                jni_sig!("(Landroid/content/Context;)V"),
                context,
            )?;
            env.call_method(
                &keyboard,
                jni_str!("setAlpha"),
                jni_sig!("(F)V"),
                &[JValue::Float(0.01)],
            )?;
            const MATCH_PARENT: i32 = -1;
            for (child, dimension) in [
                (&surface, MATCH_PARENT),
                (&keyboard, 1),
                (&overlay, MATCH_PARENT),
            ] {
                env.call_method(
                    &root,
                    jni_str!("addView"),
                    jni_sig!("(Landroid/view/View;II)V"),
                    &[
                        JValue::Object(child),
                        JValue::Int(dimension),
                        JValue::Int(dimension),
                    ],
                )?;
            }
            env.call_method(
                &activity,
                jni_str!("setContentView"),
                jni_sig!("(Landroid/view/View;)V"),
                &[JValue::Object(&root)],
            )?;
            Ok(surface.into_raw())
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

/// The Android UI thread routes an entire button sequence to its starting view.
/// Rust uses the current video viewport and the same button state as UIKit.
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativePointer<
    'local,
>(
    _env: EnvUnowned<'local>,
    _class: JClass<'local>,
    phase: jint,
    buttons: jint,
    x: jdouble,
    y: jdouble,
) {
    use crate::input::PointerPhase;
    let mask = (buttons & 0x1f) as u8;
    let phase = match phase {
        0 => PointerPhase::Hover,
        1 => PointerPhase::Begin(mask),
        2 => PointerPhase::Drag(mask),
        3 => PointerPhase::End,
        _ => return,
    };
    crate::android::send_pointer(phase, (x, y));
}
