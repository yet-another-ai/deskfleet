package io.github.yet_another_ai.deskfleet.nativedesktop

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Surface
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.lang.ref.WeakReference
import java.util.UUID

@CapacitorPlugin(
    name = "DeskFleetBridge",
    permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "audio")],
)
class DeskFleetBridge : Plugin() {
    private var speechInput: SpeechInput? = null
    private var nativeFiles: NativeFilesBridge? = null

    private fun files(): NativeFilesBridge = nativeFiles ?: NativeFilesBridge(context).also { nativeFiles = it }

    @PluginMethod
    fun filesOpen(call: PluginCall) = files().open(call)

    @PluginMethod
    fun filesCall(call: PluginCall) = files().call(call)

    @PluginMethod
    fun filesClose(call: PluginCall) = files().close(call)

    @PluginMethod
    fun filesChooseDirectory(call: PluginCall) {
        val currentActivity = activity ?: return call.reject("Activity unavailable")
        files().choose(
            call,
            dispatch = { task -> currentActivity.runOnUiThread { task() } },
            launch = { intent, receive ->
                // Capacitor shares lastPluginCallId across activity callbacks. A separate
                // registry key binds even a late result to this exact folder request.
                val launcher = currentActivity.activityResultRegistry.register(
                    "deskfleet-files-${UUID.randomUUID()}",
                    ActivityResultContracts.StartActivityForResult(),
                    { result -> receive(result) },
                )
                try { launcher.launch(intent) }
                catch (error: Exception) { launcher.unregister(); throw error }
                val unregister: () -> Unit = { currentActivity.runOnUiThread { launcher.unregister() } }
                unregister
            },
        )
    }

    private fun speech(): SpeechInput = speechInput ?: SpeechInput(context) {
        notifyListeners("speechEvent", it)
    }.also { speechInput = it }

    @PluginMethod
    fun speechStatus(call: PluginCall) {
        Handler(Looper.getMainLooper()).post {
            call.resolve(JSObject().put("supported", speech().isSupported()))
        }
    }

    @PluginMethod
    fun startSpeech(call: PluginCall) {
        val sessionId = call.getString("sessionId")?.takeIf { it.isNotEmpty() }
            ?: return call.reject("Missing speech session ID")
        val locale = call.getString("locale")?.takeIf { it.isNotEmpty() }
            ?: return call.reject("Missing speech locale")
        Handler(Looper.getMainLooper()).post {
            speech().prepare(sessionId, locale)
            if (getPermissionState("audio") != PermissionState.GRANTED) {
                requestPermissionForAlias("audio", call, "handleSpeechPermission")
            } else {
                speech().start(sessionId)
                call.resolve()
            }
        }
    }

    @PermissionCallback
    private fun handleSpeechPermission(call: PluginCall) {
        val sessionId = call.getString("sessionId") ?: return call.resolve()
        Handler(Looper.getMainLooper()).post {
            if (getPermissionState("audio") == PermissionState.GRANTED) speech().start(sessionId)
            else speech().fail(sessionId, "permission-denied")
            call.resolve()
        }
    }

    @PluginMethod
    fun stopSpeech(call: PluginCall) {
        Handler(Looper.getMainLooper()).post {
            call.getString("sessionId")?.let { speechInput?.stop(it) }
            call.resolve()
        }
    }

    @PluginMethod
    fun cancelSpeech(call: PluginCall) {
        Handler(Looper.getMainLooper()).post {
            call.getString("sessionId")?.let { speechInput?.cancel(it) }
            call.resolve()
        }
    }

    @Suppress("unused")
    fun onViewerEvent(payload: String) {
        notifyListeners("viewerEvent", JSObject().put("payload", payload))
    }

    @PluginMethod
    fun getInstallSource(call: PluginCall) {
        runCatching {
            val installer = context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
            call.resolve(JSObject().put("installerPackageName", installer))
        }.getOrElse { call.reject(it.message ?: "Failed to read install source") }
    }

    @PluginMethod
    fun openExternal(call: PluginCall) {
        val url = call.getString("url")?.takeIf { it.isNotEmpty() }
            ?: return call.reject("Missing URL")
        val currentActivity = activity ?: return call.reject("Activity unavailable")
        runCatching {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                putExtras(Bundle().apply { putBinder("android.support.customtabs.extra.SESSION", null) })
            }
            currentActivity.startActivity(intent)
        }.fold({ call.resolve() }, { call.reject(it.message ?: "Failed to open URL") })
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val currentActivity = activity ?: return call.reject("Activity unavailable")
        runCatching {
            nativeStart(this)
            currentActivity.startActivity(Intent(currentActivity, RemoteDesktopActivity::class.java))
        }.fold({ call.resolve() }, { call.reject(it.message ?: "Failed to open native desktop") })
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val command = call.getString("command")?.takeIf { it.isNotEmpty() }
            ?: return call.reject("Missing command payload")
        runCatching { nativeSendCommand(command) }
            .fold({ call.resolve() }, { call.reject(it.message ?: "Failed to send command") })
    }

    @PluginMethod
    fun close(call: PluginCall) {
        runCatching { stopSession() }
            .fold({ call.resolve() }, { call.reject(it.message ?: "Failed to close native desktop") })
    }

    @PluginMethod
    fun testNat(call: PluginCall) {
        val server = call.getString("server")?.takeIf { it.isNotEmpty() }
            ?: return call.reject("Missing STUN server")
        Thread {
            runCatching { JSObject(nativeTestNat(server)) }
                .fold(
                    { response ->
                        val error = response.getString("error")
                        if (!error.isNullOrEmpty()) call.reject(error)
                        else response.getJSObject("result")?.let(call::resolve) ?: call.reject("Missing NAT test result")
                    },
                    { call.reject(it.message ?: "Failed to test NAT") },
                )
        }.start()
    }

    @PluginMethod
    fun outlineAudioStatus(call: PluginCall) {
        val active = OutlineAudioCaptureService.isActive
        if (active) activeOutlinePlugin = WeakReference(this)
        call.resolve(JSObject().put("supported", true).put("active", active))
    }

    @PluginMethod
    fun startOutlineAudio(call: PluginCall) {
        activeOutlinePlugin = WeakReference(this)
        if (OutlineAudioCaptureService.isActive) {
            return call.resolve(JSObject().put("started", true))
        }
        if (getPermissionState("audio") != PermissionState.GRANTED) {
            return requestPermissionForAlias("audio", call, "handleOutlineAudioPermission")
        }
        launchOutlineAudioProjectionPrompt(call)
    }

    @PluginMethod
    fun stopOutlineAudio(call: PluginCall) {
        OutlineAudioCaptureService.stop(context)
        call.resolve()
    }

    @PermissionCallback
    private fun handleOutlineAudioPermission(call: PluginCall) {
        if (getPermissionState("audio") != PermissionState.GRANTED) {
            return call.reject("Audio capture permission denied.", "permission-denied")
        }
        launchOutlineAudioProjectionPrompt(call)
    }

    private fun launchOutlineAudioProjectionPrompt(call: PluginCall) {
        val manager = activity?.getSystemService(MediaProjectionManager::class.java)
            ?: return call.reject("Screen capture service unavailable.", "unavailable")
        val intent = manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        startActivityForResult(call, intent, "handleOutlineAudioProjectionResult")
    }

    @ActivityCallback
    private fun handleOutlineAudioProjectionResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            return call.resolve(JSObject().put("started", false))
        }
        pendingOutlineStartCall = call
        runCatching {
            ContextCompat.startForegroundService(context, OutlineAudioCaptureService.createStartIntent(context, data))
        }.onFailure { err ->
            pendingOutlineStartCall = null
            call.reject(err.message ?: "Failed to start system audio capture", "unavailable")
        }
    }

    private fun emitOutlineSpectrum(sampleRate: Int, binsBase64: String) {
        notifyListeners("outlineAudioBands", JSObject().put("sampleRate", sampleRate).put("bins", binsBase64))
    }

    private fun emitOutlineStopped() {
        notifyListeners("outlineAudioStopped", JSObject())
    }

    override fun handleOnPause() {
        Handler(Looper.getMainLooper()).post { speechInput?.pause() }
        super.handleOnPause()
    }

    override fun handleOnDestroy() {
        Handler(Looper.getMainLooper()).post { speechInput?.dispose() }
        nativeFiles?.dispose()
        stopSession()
        OutlineAudioCaptureService.stop(context)
        super.handleOnDestroy()
    }

    companion object {
        init {
            System.loadLibrary("deskfleet_desktop_viewer")
        }

        // Activity results and service start commands both run on the main thread.
        private var pendingOutlineStartCall: PluginCall? = null

        @Volatile internal var activeActivity: WeakReference<RemoteDesktopActivity>? = null
        @Volatile private var activeOutlinePlugin: WeakReference<DeskFleetBridge>? = null

        internal fun completeOutlineAudioStart(started: Boolean, errorMessage: String?) {
            val call = pendingOutlineStartCall ?: return
            pendingOutlineStartCall = null
            if (started) call.resolve(JSObject().put("started", true))
            else call.reject(errorMessage ?: "Failed to start system audio capture", "unavailable")
        }

        internal fun onOutlineAudioSpectrum(sampleRate: Int, binsBase64: String) {
            activeOutlinePlugin?.get()?.emitOutlineSpectrum(sampleRate, binsBase64)
        }

        internal fun onOutlineAudioStopped() {
            activeOutlinePlugin?.get()?.emitOutlineStopped()
        }

        internal fun stopSession() {
            nativeStop()
            activeActivity?.get()?.let { act ->
                act.runOnUiThread { if (!act.isFinishing && !act.isDestroyed) act.finish() }
            }
            activeActivity = null
        }

        @JvmStatic external fun nativeStart(callback: Any)
        @JvmStatic external fun nativeSendCommand(commandJson: String)
        @JvmStatic external fun nativeStop()
        @JvmStatic external fun nativeSurfaceCreated(surface: Surface, width: Int, height: Int)
        @JvmStatic external fun nativeSurfaceChanged(width: Int, height: Int)
        @JvmStatic external fun nativeSurfaceDestroyed()
        @JvmStatic external fun nativeTouch(kind: Int, x: Double, y: Double, dx: Double, dy: Double)
        @JvmStatic external fun nativeTestNat(server: String): String
    }
}
