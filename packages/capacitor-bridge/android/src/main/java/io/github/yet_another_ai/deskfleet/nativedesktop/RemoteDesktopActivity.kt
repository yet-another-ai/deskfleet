package io.github.yet_another_ai.deskfleet.nativedesktop

import android.content.ClipData
import android.content.ClipboardManager
import android.os.Bundle
import android.view.MotionEvent
import android.view.KeyEvent
import android.view.SurfaceHolder
import android.view.WindowManager
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject
import java.lang.ref.WeakReference

class RemoteDesktopActivity : AppCompatActivity(), SurfaceHolder.Callback {

    private lateinit var controls: RemoteDesktopControls
    private lateinit var pointer: RemoteDesktopPointer
    private lateinit var touch: RemoteDesktopTouch
    private var fullscreen = true
    private var closeSent = false
    private val clipboardSync = RemoteDesktopClipboard()
    private var clipboardManager: ClipboardManager? = null
    private val clipListener = ClipboardManager.OnPrimaryClipChangedListener {
        syncLocalClipboardToRemote()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DeskFleetBridge.activeActivity = WeakReference(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        updateSystemBars()

        clipboardManager = getSystemService(ClipboardManager::class.java)?.also {
            it.addPrimaryClipChangedListener(clipListener)
        }

        controls = RemoteDesktopControls(this, DeskFleetBridge::nativeSendCommand,
            DeskFleetBridge::emitViewerAction, { syncLocalClipboardToRemote(force = true) }, ::requestCloseAndFinish) {
            fullscreen = !fullscreen
            updateSystemBars()
        }
        controls.surface.holder.addCallback(this)
        touch = RemoteDesktopTouch(controls.surface, controls).also { it.attach() }
        pointer = RemoteDesktopPointer(controls)
        controls.onRelease = touch::reset
        DeskFleetBridge.viewerUiState?.let(controls::applyState)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!controls.closeKeyboard()) requestCloseAndFinish()
            }
        })
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean =
        (::pointer.isInitialized && pointer.dispatch(event)) || super.dispatchTouchEvent(event)

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean =
        (::pointer.isInitialized && pointer.dispatch(event)) || super.dispatchGenericMotionEvent(event)

    override fun dispatchKeyEvent(event: KeyEvent): Boolean =
        (::pointer.isInitialized && pointer.handlesNavigation(event)) ||
        (::controls.isInitialized && controls.handleHardwareKey(event)) || super.dispatchKeyEvent(event)

    override fun dispatchKeyShortcutEvent(event: KeyEvent): Boolean =
        (::controls.isInitialized && controls.handleHardwareKey(event)) || super.dispatchKeyShortcutEvent(event)

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            updateSystemBars()
            window.decorView.post { syncLocalClipboardToRemote(onFocus = true) }
        } else {
            if (::pointer.isInitialized) pointer.reset()
            if (::controls.isInitialized) controls.release()
        }
    }

    internal fun applyUiState(state: JSONObject) {
        runOnUiThread { if (::controls.isInitialized) controls.applyState(state) }
    }

    internal fun applyRemoteClipboard(payload: String) {
        if (::controls.isInitialized && !controls.clipboardSharing) return
        val text = clipboardSync.acceptIncomingEvent(payload) ?: return
        runOnUiThread {
            runCatching {
                clipboardManager?.setPrimaryClip(ClipData.newPlainText("DeskFleet", text))
            }
        }
    }

    private fun syncLocalClipboardToRemote(onFocus: Boolean = false, force: Boolean = false) {
        if (!::controls.isInitialized || !controls.input.enabled || (!force && !controls.clipboardSharing)) return
        runCatching {
            val clip = clipboardManager?.primaryClip
            val text = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).text else null
            val command = if (onFocus) {
                clipboardSync.takeFocusCommand(text)
            } else {
                clipboardSync.takeOutgoingCommand(text)
            } ?: return
            DeskFleetBridge.nativeSendCommand(command)
        }
    }

    private fun updateSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            if (fullscreen) hide(WindowInsetsCompat.Type.systemBars())
            else show(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun requestCloseAndFinish() {
        if (::controls.isInitialized) controls.release()
        if (!closeSent) {
            closeSent = true
            DeskFleetBridge.nativeTouch(7, 0.0, 0.0, 0.0, 0.0)
        }
        finish()
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        val frame = holder.surfaceFrame
        DeskFleetBridge.nativeSurfaceCreated(
            holder.surface,
            frame.width().coerceAtLeast(1),
            frame.height().coerceAtLeast(1),
        )
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        DeskFleetBridge.nativeSurfaceChanged(width, height)
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        DeskFleetBridge.nativeSurfaceDestroyed()
    }

    override fun onDestroy() {
        if (::controls.isInitialized) controls.destroy()
        runCatching { clipboardManager?.removePrimaryClipChangedListener(clipListener) }
        val active = DeskFleetBridge.activeActivity?.get() === this
        if (active) DeskFleetBridge.activeActivity = null
        if (active && isFinishing && !closeSent) {
            closeSent = true
            DeskFleetBridge.nativeTouch(7, 0.0, 0.0, 0.0, 0.0)
        }
        super.onDestroy()
    }
}
