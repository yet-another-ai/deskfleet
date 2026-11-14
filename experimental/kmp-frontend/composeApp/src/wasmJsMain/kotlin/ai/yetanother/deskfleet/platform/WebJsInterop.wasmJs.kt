package ai.yetanother.deskfleet.platform

import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.js.JsAny
import kotlinx.coroutines.suspendCancellableCoroutine

@JsFun("() => Date.now()")
internal external fun jsDateNowDouble(): Double

@JsFun("() => globalThis.__deskfleetWebHost.serverOrigin()")
internal external fun jsServerOrigin(): String

@JsFun("() => globalThis.__deskfleetWebHost.hostname()")
internal external fun jsHostname(): String

@JsFun("() => globalThis.__deskfleetWebHost.userAgent()")
internal external fun jsUserAgent(): String

@JsFun("() => globalThis.__deskfleetWebHost.currentPath()")
internal external fun jsCurrentPath(): String

@JsFun("(name) => globalThis.__deskfleetWebHost.queryParam(name)")
internal external fun jsQueryParam(name: String): String

@JsFun("() => globalThis.__deskfleetWebHost.consumeFragmentToken()")
internal external fun jsConsumeFragmentToken(): String

@JsFun("(path) => { globalThis.__deskfleetWebHost.navigate(path); }")
internal external fun jsNavigate(path: String)

@JsFun("(url) => { globalThis.__deskfleetWebHost.openUrl(url); }")
internal external fun jsOpenUrl(url: String)

@JsFun("(key) => globalThis.__deskfleetWebHost.storageGet(key)")
internal external fun jsStorageGet(key: String): String

@JsFun("(key, value) => { globalThis.__deskfleetWebHost.storageSet(key, value); }")
internal external fun jsStorageSet(key: String, value: String)

@JsFun("(text) => { globalThis.__deskfleetWebHost.copyText(text); }")
internal external fun jsCopyText(text: String)

@JsFun("() => globalThis.__deskfleetWebHost.readClipboardCached()")
internal external fun jsReadClipboardCached(): String

@JsFun("(enabled) => { globalThis.__deskfleetWebHost.setKeepAwake(enabled); }")
internal external fun jsSetKeepAwake(enabled: Boolean)

@JsFun("(title, body) => { globalThis.__deskfleetWebHost.notify(title, body); }")
internal external fun jsNotify(title: String, body: String)

@JsFun("() => globalThis.__deskfleetWebHost.passkeysAvailable()")
internal external fun jsPasskeysAvailable(): Boolean

@JsFun("(publicKeyJson) => globalThis.__deskfleetWebHost.authenticatePasskeyJson(publicKeyJson)")
internal external fun jsAuthenticatePasskeyPromise(publicKeyJson: String): JsAny

@JsFun("(publicKeyJson) => globalThis.__deskfleetWebHost.registerPasskeyJson(publicKeyJson)")
internal external fun jsRegisterPasskeyPromise(publicKeyJson: String): JsAny

@JsFun("() => globalThis.__deskfleetWebHost.listLocalFilesJson()")
internal external fun jsListLocalFilesJson(): String

@JsFun("(path) => globalThis.__deskfleetWebHost.readLocalFileBase64(path)")
internal external fun jsReadLocalFileBase64(path: String): String

@JsFun("(fileName, b64) => globalThis.__deskfleetWebHost.saveDownloadBase64(fileName, b64)")
internal external fun jsSaveDownloadBase64(fileName: String, b64: String): String

@JsFun("(configJson) => globalThis.__deskfleetWebHost.rtcCreatePeer(configJson)")
internal external fun jsRtcCreatePeer(configJson: String): Int

@JsFun("(id, label) => { globalThis.__deskfleetWebHost.rtcCreateDataChannel(id, label); }")
internal external fun jsRtcCreateDataChannel(id: Int, label: String)

@JsFun("(id) => globalThis.__deskfleetWebHost.rtcCreateOffer(id)")
internal external fun jsRtcCreateOfferPromise(id: Int): JsAny

@JsFun("(id, offerSdp) => globalThis.__deskfleetWebHost.rtcAnswerOffer(id, offerSdp)")
internal external fun jsRtcAnswerOfferPromise(id: Int, offerSdp: String): JsAny

@JsFun("(id, answerSdp) => globalThis.__deskfleetWebHost.rtcAcceptAnswer(id, answerSdp)")
internal external fun jsRtcAcceptAnswerPromise(id: Int, answerSdp: String): JsAny

@JsFun("(id, candidateJson) => globalThis.__deskfleetWebHost.rtcAddIceCandidate(id, candidateJson)")
internal external fun jsRtcAddIceCandidatePromise(id: Int, candidateJson: String): JsAny

@JsFun("(id, label, dataBase64) => { globalThis.__deskfleetWebHost.rtcSendBase64(id, label, dataBase64); }")
internal external fun jsRtcSendBase64(id: Int, label: String, dataBase64: String)

@JsFun("(id, label, text) => { globalThis.__deskfleetWebHost.rtcSendText(id, label, text); }")
internal external fun jsRtcSendText(id: Int, label: String, text: String)

@JsFun("(id, timeoutMs) => globalThis.__deskfleetWebHost.rtcPollEventJson(id, timeoutMs)")
internal external fun jsRtcPollEventPromise(id: Int, timeoutMs: Int): JsAny

@JsFun("(id, afterSeq) => globalThis.__deskfleetWebHost.rtcPollVideoFrameJson(id, afterSeq)")
internal external fun jsRtcPollVideoFrameJson(id: Int, afterSeq: Int): String

@JsFun("(id) => { globalThis.__deskfleetWebHost.rtcClose(id); }")
internal external fun jsRtcClose(id: Int)

@JsFun("(server) => globalThis.__deskfleetWebHost.rtcProbeNatJson(server)")
internal external fun jsRtcProbeNatPromise(server: String): JsAny

@JsFun("(promise, onResolve, onReject) => { promise.then((v) => onResolve(String(v ?? '')), (e) => onReject(String((e && e.message) || e || 'JS error'))); }")
private external fun observeStringPromise(
    promise: JsAny,
    onResolve: (String) -> Unit,
    onReject: (String) -> Unit,
)

internal suspend fun JsAny.awaitJsString(): String = suspendCancellableCoroutine { cont ->
    observeStringPromise(
        this,
        onResolve = { if (cont.isActive) cont.resume(it) },
        onReject = { if (cont.isActive) cont.resumeWithException(IllegalStateException(it)) },
    )
}
