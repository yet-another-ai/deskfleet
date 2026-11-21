package io.github.yet_another_ai.deskfleet.nativedesktop

import android.content.res.Configuration
import android.graphics.RectF
import android.view.MotionEvent
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject

/** Platform adapter for the shared Rust NSH controls; no toolbar or keyboard layout lives here. */
internal class RemoteDesktopControls(
    private val root: FrameLayout,
    private val send: (String) -> Unit,
    private val emit: (JSONObject) -> Unit,
    private val clipboard: () -> Unit,
    private val close: () -> Unit,
    private val toggleFullscreen: () -> Unit,
) {
    private val context = root.context
    private val density get() = context.resources.displayMetrics.density
    val input = RemoteDesktopInput(send)
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
    /** The open toolbar dropdown: "control", "config", or "monitor". */
    private var panel: String? = null
    private var hackerOpen = false
    private var collapsed = false
    private var selectOpen = false
    private var imeVisible = false
    private var destroyed = false
    private var nativeHandle = 0L
    private var ui = JSONObject().put("status", "connecting").put("title", "")
        .put("displays", JSONArray()).put("displayId", 0).put("control", false)
        .put("inputReady", false).put("secureAttention", false)
    private var safe = RectF()
    private val toolbar = RectF(12f, 12f, 292f, 100f)
    private val panelBounds = RectF(12f, 108f, 300f, 420f)
    private val hacker = RectF(12f, 120f, 340f, 400f)
    private var keyboardLimit = Pair(328f, 280f)
    private var gripStart: Pair<Float, Float>? = null
    private var gripOrigin = Pair(12f, 12f)
    private val keyboard = RemoteDesktopKeyboard(context, input).apply { alpha = 0.01f }
    private val overlay = NshDesktopOverlay(context, ::hitTest, ::dragToolbar)

    init {
        root.addView(keyboard, FrameLayout.LayoutParams(1, 1))
        root.addView(overlay, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        overlay.setErrorListener { message ->
            if (!destroyed) emit(JSONObject().put("type", "error").put("error", message))
        }
        nativeHandle = DeskFleetBridge.nativeAttachControls(overlay, this, snapshot().toString())
        overlay.runRustApp("deskfleet")
        keyboard.onInput = ::publish
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> layout() }
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
            safe = RectF(bars.left / density, bars.top / density, bars.right / density, maxOf(bars.bottom, ime.bottom) / density)
            layout()
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
        if (!connected()) {
            panel = null
            selectOpen = false
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
                val next = action.getString("value")
                panel = if (panel == next) null else next
                hackerOpen = false
                selectOpen = false
            }
            "selectDisplay" -> {
                release()
                panel = null
                selectOpen = false
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
                panel = null
                emit(JSONObject().put("type", action.getString("type")))
            }
            "toggleMouseMode" -> { release(); relative = !relative; resetPointer() }
            "toggleKeyboard" -> toggleKeyboard()
            "toggleHackerKeyboard" -> if (input.enabled) {
                release()
                hackerOpen = !hackerOpen
                panel = null
                selectOpen = false
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
                collapsed = !collapsed
                panel = null
                hackerOpen = false
                selectOpen = false
                input.clearModifiers()
            }
            "selectOpen" -> { selectOpen = action.getBoolean("value"); if (selectOpen) release() }
            "measured" -> {
                val size = action.getJSONArray("value")
                if (sameSize(toolbar, size)) return
                toolbar.right = toolbar.left + size.getDouble(0).toFloat()
                toolbar.bottom = toolbar.top + size.getDouble(1).toFloat()
            }
            "panelMeasured" -> {
                val height = action.getDouble("value").toFloat()
                if (kotlin.math.abs(panelBounds.height() - height) < 0.5f) return
                panelBounds.bottom = panelBounds.top + height
            }
            "keyboardMeasured" -> {
                val size = action.getJSONArray("value")
                if (sameSize(hacker, size)) return
                hacker.right = hacker.left + size.getDouble(0).toFloat()
                hacker.bottom = hacker.top + size.getDouble(1).toFloat()
            }
        }
        layout()
    }

    private fun sameSize(rect: RectF, size: JSONArray) =
        kotlin.math.abs(rect.width() - size.getDouble(0)) < 0.5 && kotlin.math.abs(rect.height() - size.getDouble(1)) < 0.5

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
        if (imeVisible) { hideKeyboard(); return true }
        if (hackerOpen) { hackerOpen = false; input.clearModifiers(); publish(); return true }
        if (panel != null) { panel = null; selectOpen = false; publish(); return true }
        return false
    }

    fun focusKeyboard() { if (input.enabled) keyboard.requestFocus() }

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
        if (imeVisible) hideKeyboard()
        else {
            keyboard.requestFocus()
            context.getSystemService(InputMethodManager::class.java)?.showSoftInput(keyboard, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun hideKeyboard() {
        keyboard.cancelComposition()
        context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(keyboard.windowToken, 0)
        keyboard.clearFocus()
    }

    private fun hitTest(x: Float, y: Float): Boolean {
        val pointX = x / density
        val pointY = y / density
        return !connected() || selectOpen || toolbar.contains(pointX, pointY) ||
            (panel != null && panelBounds.contains(pointX, pointY)) ||
            (hackerOpen && hacker.contains(pointX, pointY))
    }

    private fun dragToolbar(event: MotionEvent): Boolean {
        val x = event.x / density
        val y = event.y / density
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            // The shared bar has a 1pt border and 4pt padding around its 44x40pt grip.
            val gripLeft = toolbar.left + 5f
            val gripTop = toolbar.top + 5f
            if (selectOpen || x < gripLeft || x >= gripLeft + 44f || y < gripTop || y >= gripTop + 40f) return false
            release()
            gripStart = Pair(x, y)
            gripOrigin = Pair(toolbar.left, toolbar.top)
        }
        val start = gripStart ?: return false
        if (event.actionMasked == MotionEvent.ACTION_MOVE) {
            toolbar.offsetTo(gripOrigin.first + x - start.first, gripOrigin.second + y - start.second)
            layout()
        }
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) gripStart = null
        return true
    }

    private fun layout() {
        if (destroyed) return
        val width = root.width / density
        val height = root.height / density
        if (width <= 0 || height <= 0) return
        val left = safe.left + 8f
        val top = safe.top + 8f
        val right = (width - safe.right - 8f).coerceAtLeast(left)
        val bottom = (height - safe.bottom - 8f).coerceAtLeast(top)
        val toolbarBottom = if (hackerOpen) (bottom - 88f).coerceAtLeast(top) else bottom
        toolbar.offsetTo(toolbar.left.coerceIn(left, (right - toolbar.width()).coerceAtLeast(left)), toolbar.top.coerceIn(top, (toolbarBottom - toolbar.height()).coerceAtLeast(top)))
        panelBounds.right = panelBounds.left + minOf(288f, (width - safe.left - safe.right - 24f).coerceAtLeast(0f))
        val panelY = if (toolbar.bottom + 8f + panelBounds.height() <= bottom) toolbar.bottom + 8f else toolbar.top - panelBounds.height() - 8f
        panelBounds.offsetTo(toolbar.left.coerceIn(left, (right - panelBounds.width()).coerceAtLeast(left)), panelY.coerceIn(top, (bottom - panelBounds.height()).coerceAtLeast(top)))
        keyboardLimit = Pair((right - left).coerceAtLeast(0f), (bottom - toolbar.bottom - 8f).coerceIn(40f, 320f))
        hacker.offsetTo(left, (bottom - minOf(hacker.height(), keyboardLimit.second)).coerceAtLeast(top))
        publish()
    }

    private fun snapshot(): JSONObject {
        val modifiers = listOf("ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft").map { it in input.modifiers }
        return JSONObject().put("ui", ui).put("mobile", true).put("paused", paused)
            .put("reverseScroll", reverseScroll).put("clipboardSharing", clipboardSharing)
            .put("fullscreen", fullscreen)
            .put("dark", context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES)
            .put("panel", panel ?: JSONObject.NULL).put("pinchZoom", pinchZoom).put("relativeMouse", relative)
            .put("keyboardOpen", imeVisible).put("hackerOpen", hackerOpen)
            .put("pasteShift", input.pasteShift).put("dragging", dragging).put("collapsed", collapsed)
            .put("modifiers", JSONArray(modifiers))
            .put("position", JSONArray(listOf(toolbar.left, toolbar.top)))
            .put("toolbarSize", JSONArray(listOf(toolbar.width(), toolbar.height())))
            .put("viewport", JSONArray(listOf(
                (root.width / density - safe.left - safe.right).coerceAtLeast(0f),
                (root.height / density - safe.top - safe.bottom).coerceAtLeast(0f),
            )))
            .put("panelPosition", JSONArray(listOf(panelBounds.left, panelBounds.top))).put("panelHeight", panelBounds.height())
            .put("keyboardPosition", JSONArray(listOf(hacker.left, hacker.top)))
            .put("keyboardSize", JSONArray(listOf(keyboardLimit.first, keyboardLimit.second)))
    }

    private fun publish() {
        if (!destroyed && nativeHandle != 0L) DeskFleetBridge.nativeUpdateControls(nativeHandle, snapshot().toString())
    }
}
