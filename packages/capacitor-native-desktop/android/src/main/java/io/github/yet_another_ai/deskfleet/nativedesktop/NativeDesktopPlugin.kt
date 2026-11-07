package io.github.yet_another_ai.deskfleet.nativedesktop

import android.content.Intent
import android.view.Surface
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.lang.ref.WeakReference

@CapacitorPlugin(name = "NativeDesktop")
class NativeDesktopPlugin : Plugin() {

    @Suppress("unused")
    fun onViewerEvent(payload: String) {
        notifyListeners("viewerEvent", JSObject().put("payload", payload))
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

    override fun handleOnDestroy() {
        stopSession()
        super.handleOnDestroy()
    }

    companion object {
        init {
            System.loadLibrary("deskfleet_desktop_viewer")
        }

        @Volatile
        internal var activeActivity: WeakReference<RemoteDesktopActivity>? = null

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
    }
}
