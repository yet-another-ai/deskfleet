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
    private val setFullscreen: (Boolean) -> Unit,
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
        val wasEnabled = input.enabled
        val oldDisplay = ui.optInt("displayId", -1)
        ui = value
        input.pasteCode = if (ui.optString("platform") == "darwin") "MetaLeft" else "ControlLeft"
        if (input.pasteCode == "MetaLeft") input.pasteShift = false
        dispatchAction(JSONObject().put("type", "sessionChanged").put("value", JSONObject()
            .put("wasEnabled", wasEnabled).put("displayChanged", oldDisplay != ui.optInt("displayId", -1))).toString())
    }

    /** Called by Rust on its engine thread, with all Android work queued on the UI thread. */
    @Suppress("unused")
    fun onControlsAction(payload: String) {
        root.post {
            if (!destroyed) dispatchAction(payload)
        }
    }

    /** Evaluate and execute on the UI thread so each action sees the preceding effects. */
    private fun dispatchAction(payload: String) {
        val effects = JSONArray(DeskFleetBridge.nativeControlEffects(snapshot().toString(), payload))
        for (index in 0 until effects.length()) executeEffect(effects.getJSONObject(index))
        input.enabled = available() && !paused
        publish()
    }

    private fun executeEffect(effect: JSONObject) {
        when (effect.getString("type")) {
            "release" -> release(effect.getBoolean("value"))
            "paused" -> {
                paused = effect.getBoolean("value")
                send(JSONObject().put("type", "pauseInput").put("paused", paused).toString())
            }
            "relativeMouse" -> relative = effect.getBoolean("value")
            "dragButton" -> {
                dragging = effect.getBoolean("value")
                DeskFleetBridge.nativeTouch(if (dragging) 11 else 12, 0.0, 0.0, 0.0, 0.0)
            }
            "resetPointer" -> resetPointer()
            "hackerOpen" -> hackerOpen = effect.getBoolean("value")
            "modifiers" -> {
                val values = effect.getJSONArray("value")
                input.setModifiers(List(values.length()) { values.getBoolean(it) })
            }
            "chord" -> {
                val codes = effect.getJSONArray("value")
                // The ordered chord batch releases the remote; only reset local gestures here.
                onRelease()
                dragging = false
                keyboard.cancelComposition()
                input.chord(List(codes.length()) { codes.getString(it) })
            }
            "fullscreen" -> {
                fullscreen = effect.getBoolean("value")
                setFullscreen(fullscreen)
            }
            "keyboard" -> setKeyboardOpen(effect.getBoolean("value"))
            "pasteShift" -> input.pasteShift = effect.getBoolean("value")
            "reverseScroll" -> reverseScroll = effect.getBoolean("value")
            "clipboardSharing" -> clipboardSharing = effect.getBoolean("value")
            "syncClipboard" -> clipboard()
            "pinchZoom" -> pinchZoom = effect.getBoolean("value")
            "resetZoom" -> resetZoom()
            "secureAttention" -> input.secureAttention()
            "emit" -> emit(effect.getJSONObject("value"))
            "close" -> close()
        }
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

    private fun resetPointer() = DeskFleetBridge.nativeTouch(14, 0.0, 0.0, 0.0, 0.0)

    private fun resetZoom() = DeskFleetBridge.nativeTouch(17, 0.0, 0.0, 0.0, 0.0)

    private fun setKeyboardOpen(open: Boolean) {
        if (!open) hideKeyboard()
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
