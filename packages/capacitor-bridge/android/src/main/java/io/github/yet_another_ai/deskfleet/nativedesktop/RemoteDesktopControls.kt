package io.github.yet_another_ai.deskfleet.nativedesktop

import android.app.Activity
import android.content.res.Configuration
import android.graphics.RectF
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.InputMethodManager
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject

/** Platform adapter for the shared Rust NSH controls; no toolbar or keyboard layout lives here. */
internal class RemoteDesktopControls(
    private val context: Activity,
    private val send: (String) -> Unit,
    private val emit: (JSONObject) -> Unit,
    private val clipboard: () -> Unit,
    private val close: () -> Unit,
    private val toggleFullscreen: () -> Unit,
) {
    private val density get() = context.resources.displayMetrics.density
    val input = RemoteDesktopInput(send) { events -> DeskFleetBridge.nativeInputSequence(JSONArray(events).toString()) }
    var onRelease: () -> Unit = {}
    var relative = false
        private set
    var reverseScroll = false
        private set
    var clipboardSharing = true
        private set
    var dragging = false
        private set
    /** Local presentation zoom; it does not need input control. */
    var pinchZoom = true
        private set
    private var paused = false
    private var fullscreen = true
    private var hackerOpen = false
    private var imeVisible = false
    private var destroyed = false
    private var nativeHandle = 0L
    private var ui = JSONObject().put("status", "connecting").put("title", "")
        .put("displays", JSONArray()).put("displayId", 0).put("control", false)
        .put("inputReady", false).put("secureAttention", false)
    private var safe = RectF()
    private var gripPreviousX = 0f
    private var gripPreviousY = 0f
    private val keyboard = RemoteDesktopKeyboard(context, input)
    private val overlay = NshDesktopOverlay(context, ::hitTest, ::dragToolbar)
    val surface = DeskFleetBridge.nativeMountViewer(context, keyboard, overlay)
    private val root = surface.parent as View

    init {
        overlay.setErrorListener { message ->
            if (!destroyed) emit(JSONObject().put("type", "error").put("error", message))
        }
        nativeHandle = DeskFleetBridge.nativeAttachControls(overlay, this, snapshot().toString())
        overlay.runRustApp("deskfleet")
        surface.isFocusableInTouchMode = true
        surface.requestFocus()
        keyboard.preIme = { event -> handleHardwareKey(event, beforeIme = true) }
        keyboard.onInput = ::publish
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> publish() }
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val visible = insets.isVisible(WindowInsetsCompat.Type.ime())
            if (imeVisible && !visible && keyboard.hasFocus()) surface.requestFocus()
            imeVisible = visible
            safe = RectF(bars.left / density, bars.top / density, bars.right / density, maxOf(bars.bottom, ime.bottom) / density)
            publish()
            insets
        }
    }

    fun applyState(value: JSONObject) {
        if (destroyed) return
        val oldDisplay = ui.optInt("displayId", -1)
        ui = value
        input.pasteCode = if (ui.optString("platform") == "darwin") "MetaLeft" else "ControlLeft"
        if (input.pasteCode == "MetaLeft") input.pasteShift = false
        if (oldDisplay != ui.optInt("displayId", -1)) {
            release()
            resetPointer()
        }
        if (!ui.optBoolean("control") || !ui.optBoolean("inputReady") || !connected()) {
            if (paused) send(JSONObject().put("type", "pauseInput").put("paused", false).toString())
            paused = false
        }
        updateEnabled()
        publish()
    }

    /** Called by Rust on its engine thread, with all Android work queued on the UI thread. */
    @Suppress("unused")
    fun onControlsAction(payload: String) {
        root.post {
            if (!destroyed) handleAction(JSONObject(payload))
        }
    }

    private fun handleAction(action: JSONObject) {
        when (action.getString("type")) {
            "toggleControl" -> if (available()) {
                release()
                paused = !paused
                send(JSONObject().put("type", "pauseInput").put("paused", paused).toString())
                updateEnabled()
            }
            "toggleFullscreen" -> { fullscreen = !fullscreen; toggleFullscreen() }
            "togglePanel" -> {
                release()
                hackerOpen = false
            }
            "selectDisplay" -> {
                release()
                emit(JSONObject().put("type", "selectDisplay").put("displayId", action.getInt("value")))
            }
            "setControl" -> {
                release()
                if (paused) {
                    paused = false
                    send(JSONObject().put("type", "pauseInput").put("paused", false).toString())
                }
                emit(JSONObject().put("type", "setControl").put("control", action.getBoolean("value")))
            }
            "setReverseScroll" -> reverseScroll = action.getBoolean("value")
            "setClipboardSharing" -> clipboardSharing = action.getBoolean("value")
            "secureAttention" -> input.secureAttention()
            "shortcut" -> {
                val codes = action.getJSONArray("value")
                onRelease()
                stopDrag()
                input.chord(List(codes.length()) { codes.getString(it) })
            }
            "setPinchZoom" -> {
                pinchZoom = action.getBoolean("value")
                if (!pinchZoom) resetZoom()
            }
            "resetZoom" -> resetZoom()
            "reconnect", "disconnect" -> {
                release()
                emit(JSONObject().put("type", action.getString("type")))
            }
            "toggleMouseMode" -> { release(); relative = !relative; resetPointer() }
            "toggleKeyboard" -> toggleKeyboard()
            "toggleHackerKeyboard" -> if (input.enabled) {
                release()
                hackerOpen = !hackerOpen
            }
            "setPasteShift" -> input.pasteShift = action.getBoolean("value")
            "toggleModifier" -> input.toggleModifier(action.getString("value"))
            "key" -> input.stroke(action.getString("value"))
            "toggleDrag" -> if (input.enabled) {
                if (dragging) stopDrag()
                else {
                    release()
                    if (!relative) { relative = true; resetPointer() }
                    dragging = true
                    DeskFleetBridge.nativeTouch(11, 0.0, 0.0, 0.0, 0.0)
                }
            }
            "syncClipboard" -> if (input.enabled) clipboard()
            "close" -> close()
            "toggleCollapsed" -> {
                release()
                hackerOpen = false
                input.clearModifiers()
            }
            "selectOpen" -> if (action.getBoolean("value")) release()
        }
        publish()
    }

    fun release(preserveModifiers: Boolean = false) {
        onRelease()
        stopDrag()
        input.release(preserveModifiers)
        keyboard.cancelComposition()
        publish()
    }

    fun stopDrag() {
        if (!dragging) return
        dragging = false
        DeskFleetBridge.nativeTouch(12, 0.0, 0.0, 0.0, 0.0)
        publish()
    }

    fun closeKeyboard(): Boolean {
        if (keyboard.hasFocus()) { hideKeyboard(); return true }
        if (hackerOpen) { hackerOpen = false; input.clearModifiers(); publish(); return true }
        return DeskFleetBridge.nativeDismissPanel(nativeHandle)
    }

    fun focusVideo() {
        if (input.enabled && !keyboard.hasFocus()) {
            DeskFleetBridge.nativeDismissPanel(nativeHandle)
            surface.requestFocus()
        }
    }

    fun handleHardwareKey(event: KeyEvent, beforeIme: Boolean = false): Boolean {
        if (!input.enabled || destroyed || !surface.hasWindowFocus()) return false
        if (!keyboard.hasFocus() && DeskFleetBridge.nativeControlsOwnFocus(nativeHandle)) return false
        return keyboard.handleHardware(event, beforeIme)
    }

    fun destroy() {
        if (destroyed) return
        release()
        destroyed = true
        DeskFleetBridge.nativeDetachControls(nativeHandle)
        nativeHandle = 0
        overlay.destroy()
    }

    fun connected() = ui.optString("status") == "connected"
    private fun available() = connected() && ui.optBoolean("control") && ui.optBoolean("inputReady")

    private fun updateEnabled() {
        input.enabled = available() && !paused
        if (!input.enabled) {
            onRelease()
            stopDrag()
            hideKeyboard()
            hackerOpen = false
        }
    }

    private fun resetPointer() = DeskFleetBridge.nativeTouch(14, 0.0, 0.0, 0.0, 0.0)

    private fun resetZoom() = DeskFleetBridge.nativeTouch(17, 0.0, 0.0, 0.0, 0.0)

    private fun toggleKeyboard() {
        if (!input.enabled) return
        release(preserveModifiers = true)
        if (keyboard.hasFocus()) hideKeyboard()
        else {
            keyboard.requestFocus()
            context.getSystemService(InputMethodManager::class.java)?.showSoftInput(keyboard, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun hideKeyboard() {
        keyboard.cancelComposition()
        context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(keyboard.windowToken, 0)
        if (keyboard.hasFocus()) surface.requestFocus()
    }

    fun hitTest(x: Float, y: Float): Boolean =
        DeskFleetBridge.nativeControlsHit(nativeHandle, x / density, y / density, false)

    private fun dragToolbar(event: MotionEvent): Boolean {
        val x = event.x / density
        val y = event.y / density
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                if (!DeskFleetBridge.nativeControlsHit(nativeHandle, x, y, true)) return false
                release()
            }
            MotionEvent.ACTION_MOVE ->
                DeskFleetBridge.nativeDragToolbar(nativeHandle, x - gripPreviousX, y - gripPreviousY)
        }
        gripPreviousX = x
        gripPreviousY = y
        return true
    }

    private fun snapshot(): JSONObject {
        val modifiers = listOf("ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft").map { it in input.modifiers }
        return JSONObject().put("ui", ui).put("mobile", true).put("paused", paused)
            .put("reverseScroll", reverseScroll).put("clipboardSharing", clipboardSharing)
            .put("fullscreen", fullscreen)
            .put("dark", context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES)
            .put("pinchZoom", pinchZoom).put("relativeMouse", relative)
            .put("keyboardOpen", imeVisible).put("hackerOpen", hackerOpen)
            .put("pasteShift", input.pasteShift).put("dragging", dragging)
            .put("modifiers", JSONArray(modifiers))
            .put("viewport", JSONArray(listOf(root.width / density, root.height / density)))
            .put("insets", JSONArray(listOf(safe.left, safe.top, safe.right, safe.bottom)))
    }

    private fun publish() {
        if (!destroyed && nativeHandle != 0L) DeskFleetBridge.nativeUpdateControls(nativeHandle, snapshot().toString())
    }
}
