//! JNI bindings for Desktop JVM (macOS, Linux, Windows) and Android (`NativeBridgeJni`).

use jni::EnvUnowned;
use jni::errors::{Error as JniError, ThrowRuntimeExAndDefault};
use jni::objects::{JByteArray, JClass, JLongArray, JString};
use jni::strings::JNIString;
use jni::sys::{JNI_TRUE, jboolean, jbyteArray, jlong, jstring};

use crate::{
    accept_answer, add_ice_candidate, answer_offer, close_peer, create_data_channel, create_offer,
    create_peer, open_local_network_settings, poll_event_json, request_local_network, run_nat_test,
    send_bytes, send_text, snapshot_video_frame,
};

fn throw_and_err(env: &mut jni::Env<'_>, msg: &str) -> JniError {
    let jmsg = JNIString::new(msg);
    let _ = env.throw_new(jni::jni_str!("java/lang/IllegalStateException"), &jmsg);
    JniError::JavaException
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_yetanother_deskfleet_transport_NativeBridgeJni_peerCreate<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    config_json: JString<'local>,
) -> jlong {
    unowned_env
        .with_env(|env| -> Result<jlong, JniError> {
            let cfg = config_json.mutf8_chars(env)?.to_str().into_owned();
            match create_peer(&cfg) {
                Ok(h) => Ok(h as jlong),
                Err(err) => Err(throw_and_err(env, &err)),
            }
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_yetanother_deskfleet_transport_NativeBridgeJni_peerCreateDataChannel<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
    label: JString<'local>,
) -> jboolean {
    unowned_env
        .with_env(|env| -> Result<jboolean, JniError> {
            let lbl = label.mutf8_chars(env)?.to_str().into_owned();
            match create_data_channel(handle as u64, &lbl) {
                Ok(()) => Ok(JNI_TRUE),
                Err(err) => Err(throw_and_err(env, &err)),
            }
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_yetanother_deskfleet_transport_NativeBridgeJni_peerCreateOffer<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
) -> jstring {
    unowned_env
        .with_env(|env| -> Result<jstring, JniError> {
            match create_offer(handle as u64) {
                Ok(sdp) => Ok(JString::from_str(env, &sdp)?.into_raw()),
                Err(err) => Err(throw_and_err(env, &err)),
            }
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_yetanother_deskfleet_transport_NativeBridgeJni_peerAnswerOffer<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
    sdp: JString<'local>,
) -> jstring {
    unowned_env
        .with_env(|env| -> Result<jstring, JniError> {
            let offer = sdp.mutf8_chars(env)?.to_str().into_owned();
            match answer_offer(handle as u64, &offer) {
                Ok(ans) => Ok(JString::from_str(env, &ans)?.into_raw()),
                Err(err) => Err(throw_and_err(env, &err)),
            }
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_yetanother_deskfleet_transport_NativeBridgeJni_peerAcceptAnswer<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
    sdp: JString<'local>,
) -> jboolean {
    unowned_env
        .with_env(|env| -> Result<jboolean, JniError> {
            let ans = sdp.mutf8_chars(env)?.to_str().into_owned();
            match accept_answer(handle as u64, &ans) {
                Ok(()) => Ok(JNI_TRUE),
                Err(err) => Err(throw_and_err(env, &err)),
            }
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_yetanother_deskfleet_transport_NativeBridgeJni_peerAddIceCandidate<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
    candidate_json: JString<'local>,
) -> jboolean {
    unowned_env
        .with_env(|env| -> Result<jboolean, JniError> {
            let cand = candidate_json.mutf8_chars(env)?.to_str().into_owned();
            match add_ice_candidate(handle as u64, &cand) {
                Ok(()) => Ok(JNI_TRUE),
                Err(err) => Err(throw_and_err(env, &err)),
            }
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_yetanother_deskfleet_transport_NativeBridgeJni_peerSendBytes<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
    label: JString<'local>,
    payload: JByteArray<'local>,
) -> jboolean {
    unowned_env
        .with_env(|env| -> Result<jboolean, JniError> {
            let lbl = label.mutf8_chars(env)?.to_str().into_owned();
            let bytes = env.convert_byte_array(&payload)?;
            match send_bytes(handle as u64, &lbl, &bytes) {
                Ok(()) => Ok(JNI_TRUE),
                Err(err) => Err(throw_and_err(env, &err)),
            }
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_yetanother_deskfleet_transport_NativeBridgeJni_peerSendText<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
    label: JString<'local>,
    text: JString<'local>,
) -> jboolean {
    unowned_env
        .with_env(|env| -> Result<jboolean, JniError> {
            let lbl = label.mutf8_chars(env)?.to_str().into_owned();
            let txt = text.mutf8_chars(env)?.to_str().into_owned();
            match send_text(handle as u64, &lbl, &txt) {
                Ok(()) => Ok(JNI_TRUE),
                Err(err) => Err(throw_and_err(env, &err)),
            }
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_yetanother_deskfleet_transport_NativeBridgeJni_peerPollEvent<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
    timeout_ms: jlong,
) -> jstring {
    unowned_env
        .with_env(|env| -> Result<jstring, JniError> {
            match poll_event_json(handle as u64, timeout_ms.max(0) as u64) {
                Ok(Some(json)) => Ok(JString::from_str(env, &json)?.into_raw()),
                Ok(None) => Ok(std::ptr::null_mut()),
                Err(err) => Err(throw_and_err(env, &err)),
            }
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_yetanother_deskfleet_transport_NativeBridgeJni_peerPollVideoFrame<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
    after_seq: jlong,
    meta_out: JLongArray<'local>,
) -> jbyteArray {
    unowned_env
        .with_env(|env| -> Result<jbyteArray, JniError> {
            let Some(frame) = snapshot_video_frame(handle as u64, after_seq.max(0) as u64) else {
                return Ok(std::ptr::null_mut());
            };
            let meta = [
                frame.seq as jlong,
                i64::from(frame.width),
                i64::from(frame.height),
            ];
            meta_out.set_region(env, 0, &meta)?;
            Ok(env.byte_array_from_slice(&frame.bgra)?.into_raw())
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_yetanother_deskfleet_transport_NativeBridgeJni_peerClose<'local>(
    _unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
) {
    close_peer(handle as u64);
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_yetanother_deskfleet_transport_NativeBridgeJni_testNat<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    server: JString<'local>,
) -> jstring {
    unowned_env
        .with_env(|env| -> Result<jstring, JniError> {
            let srv = server.mutf8_chars(env)?.to_str().into_owned();
            match run_nat_test(&srv) {
                Ok(json) => Ok(JString::from_str(env, &json)?.into_raw()),
                Err(err) => Err(throw_and_err(env, &err)),
            }
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_yetanother_deskfleet_transport_NativeBridgeJni_requestLocalNetwork<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
) -> jstring {
    unowned_env
        .with_env(|env| -> Result<jstring, JniError> {
            match request_local_network() {
                Ok(status) => Ok(JString::from_str(env, status)?.into_raw()),
                Err(err) => Err(throw_and_err(env, &err)),
            }
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_yetanother_deskfleet_transport_NativeBridgeJni_openLocalNetworkSettings<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
) -> jboolean {
    unowned_env
        .with_env(|env| -> Result<jboolean, JniError> {
            match open_local_network_settings() {
                Ok(()) => Ok(JNI_TRUE),
                Err(err) => Err(throw_and_err(env, &err)),
            }
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}
