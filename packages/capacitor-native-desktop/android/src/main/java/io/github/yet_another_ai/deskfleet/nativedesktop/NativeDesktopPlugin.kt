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
import kotlin.concurrent.thread

@CapacitorPlugin(name = "NativeDesktop")
class NativeDesktopPlugin : Plugin() {
    @Volatile
    private var activeAuthServer: LoopbackAuthServer? = null

    @Suppress("unused")
    fun onViewerEvent(payload: String) {
        notifyListeners("viewerEvent", JSObject().put("payload", payload))
    }

    @PluginMethod
    fun startAuthCallback(call: PluginCall) {
        runCatching {
            activeAuthServer?.close()
            val server = LoopbackAuthServer()
            activeAuthServer = server
            JSObject().put("callbackUrl", server.callbackUrl)
        }.fold({ call.resolve(it) }, { call.reject(it.message ?: "Could not start login callback") })
    }

    @PluginMethod
    fun waitForAuthCallback(call: PluginCall) {
        val authorizationUrl = call.getString("authorizationUrl")?.takeIf { it.isNotEmpty() }
            ?: return call.reject("Missing authorization URL")
        val server = activeAuthServer ?: return call.reject("Login callback is not active")
        val currentActivity = activity ?: return call.reject("Activity unavailable")
        call.setKeepAlive(true)
        try {
            val authIntent = Intent(Intent.ACTION_VIEW, Uri.parse(authorizationUrl)).apply {
                putExtras(Bundle().apply { putBinder("android.support.customtabs.extra.SESSION", null) })
            }
            currentActivity.startActivity(authIntent)
        } catch (error: Exception) {
            activeAuthServer = null
            server.close()
            call.setKeepAlive(false)
            return call.reject(error.message ?: "Failed to open authorization URL")
        }
        thread(name = "deskfleet-wait-auth", isDaemon = true) {
            try {
                val code = server.awaitCode()
                call.resolve(JSObject().put("code", code))
            } catch (error: Exception) {
                call.reject(error.message ?: "Sign-in failed")
            } finally {
                if (activeAuthServer === server) activeAuthServer = null
                call.setKeepAlive(false)
            }
        }
    }

    @PluginMethod
    fun openExternal(call: PluginCall) {
        val url = call.getString("url")?.takeIf { it.isNotEmpty() }
            ?: return call.reject("Missing URL")
        val currentActivity = activity ?: return call.reject("Activity unavailable")
        runCatching {
            currentActivity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
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

    override fun handleOnDestroy() {
        activeAuthServer?.close()
        activeAuthServer = null
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
