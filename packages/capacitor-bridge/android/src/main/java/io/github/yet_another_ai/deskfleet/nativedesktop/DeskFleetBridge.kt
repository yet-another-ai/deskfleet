package io.github.yet_another_ai.deskfleet.nativedesktop

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.Surface
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.lang.ref.WeakReference

@CapacitorPlugin(name = "DeskFleetBridge")
class DeskFleetBridge : Plugin() {
    @Suppress("unused")
    fun onViewerEvent(payload: String) {
        notifyListeners("viewerEvent", JSObject().put("payload", payload))
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
                        if (!error.isNullOrEmpty()) {
                            call.reject(error)
                        } else {
                            val result = response.getJSObject("result")
                            if (result != null) call.resolve(result)
                            else call.reject("Missing NAT test result")
                        }
                    },
                    { call.reject(it.message ?: "Failed to test NAT") },
                )
        }.start()
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
        @JvmStatic external fun nativeTestNat(server: String): String
    }
}
