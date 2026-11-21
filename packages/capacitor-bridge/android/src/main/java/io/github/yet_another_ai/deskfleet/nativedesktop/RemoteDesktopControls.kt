package io.github.yet_another_ai.deskfleet.nativedesktop

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

/** Native controls overlay; video and authentication continue to belong to their existing owners. */
internal class RemoteDesktopControls(
    private val root: FrameLayout,
    private val send: (String) -> Unit,
    private val emit: (JSONObject) -> Unit,
    private val clipboard: () -> Unit,
    private val close: () -> Unit,
    private val toggleFullscreen: () -> Unit,
) {
    private val context = root.context
    val input = RemoteDesktopInput(send)
    var onRelease: () -> Unit = {}
    var relative = false
        private set
    var reverseScroll = false
        private set
    var clipboardSharing = true
        private set
    private var paused = false
    private var state = JSONObject()
    private var safe = Rect()
    private var imeVisible = false
    private var chinese = false
    private var expanded = true
    private val toolbar = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        background = panelBackground()
        elevation = dp(8).toFloat()
        setPadding(dp(4), dp(4), dp(4), dp(4))
    }
    private val rows = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val status = TextView(context).apply {
        setTextColor(Color.LTGRAY)
        textSize = 11f
        maxLines = 2
        setPadding(dp(8), dp(4), dp(8), dp(4))
    }
    private val grip = button("⠿", "Move controls") {}
    private val fold = button("−", "Collapse controls") { expanded = !expanded; refresh() }
    private val mode = button("", "") { switchMode() }
    private val pause = button("", "") { setPaused(!paused) }
    private val keyboardButton = button("⌨", "System keyboard") { toggleKeyboard() }
    private val hackerButton = button("⌘", "Hacker Keyboard") { toggleHacker() }
    private val displayButton = button("▣", "Displays") { showDisplays() }
    private val connectionButton = button("", "") {
        input.release()
        emit(JSONObject().put("type", if (connected()) "disconnect" else "reconnect"))
    }
    private val keyboard = RemoteDesktopKeyboard(context, input).apply { alpha = 0.01f }
    private val hacker = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        background = panelBackground()
        setPadding(dp(6), dp(6), dp(6), dp(6))
        visibility = View.GONE
        elevation = dp(8).toFloat()
    }
    private val modifierButtons = mutableMapOf<String, TextView>()
    private val inputButtons = mutableListOf<TextView>()

    init {
        root.addView(keyboard, FrameLayout.LayoutParams(1, 1))
        toolbar.addView(row(grip, fold, mode, keyboardButton, hackerButton))
        toolbar.addView(rows)
        rows.addView(row(pause, displayButton,
            button("📋", "Clipboard sharing") { if (input.enabled && clipboardSharing) clipboard() },
            button("⚙", "Settings") { showSettings() },
            connectionButton,
            button("✕", "Close desktop") { close() },
        ))
        rows.addView(status, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        root.addView(toolbar, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply {
            leftMargin = dp(12); topMargin = dp(12)
        })
        buildHackerKeyboard()
        root.addView(hacker, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))
        keyboard.onInput = { refreshModifiers() }
        makeDraggable()
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            hacker.maximumHeight(root.height - safe.top - safe.bottom)
            clampToolbar()
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bounds = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
            safe = Rect(bounds.left, bounds.top, bounds.right, maxOf(bounds.bottom, ime.bottom))
            (hacker.layoutParams as FrameLayout.LayoutParams).apply {
                leftMargin = safe.left; rightMargin = safe.right; bottomMargin = safe.bottom
                hacker.layoutParams = this
            }
            hacker.maximumHeight(root.height - safe.top - safe.bottom)
            clampToolbar()
            refresh()
            insets
        }
        refresh()
    }

    fun applyState(value: JSONObject) {
        val oldDisplay = state.optInt("displayId", -1)
        state = value
        chinese = state.optString("locale").startsWith("zh")
        input.pasteCode = if (state.optString("platform") == "darwin") "MetaLeft" else "ControlLeft"
        if (input.pasteCode == "MetaLeft") input.pasteShift = false
        if (oldDisplay != state.optInt("displayId", -1)) resetPointer()
        if (!state.optBoolean("control") || !connected()) {
            if (paused) send(JSONObject().put("type", "pauseInput").put("paused", false).toString())
            paused = false
        }
        updateEnabled()
        refresh()
    }

    fun release() {
        onRelease()
        input.release()
        keyboard.cancelComposition()
        refreshModifiers()
    }

    fun closeKeyboard(): Boolean {
        if (imeVisible) { hideKeyboard(); return true }
        if (hacker.visibility == View.VISIBLE) { toggleHacker(); return true }
        return false
    }

    fun focusKeyboard() { if (input.enabled) keyboard.requestFocus() }

    private fun connected() = state.optString("status") == "connected"
    private fun available() = connected() && state.optBoolean("control") && state.optBoolean("inputReady")
    private fun label(english: String, zh: String) = if (chinese) zh else english

    private fun updateEnabled() {
        input.enabled = available() && !paused
        if (!input.enabled) {
            onRelease()
            keyboard.cancelComposition()
            hideKeyboard()
            hacker.visibility = View.GONE
        }
    }

    private fun setPaused(value: Boolean) {
        if (!available()) return
        release()
        paused = value
        send(JSONObject().put("type", "pauseInput").put("paused", value).toString())
        updateEnabled()
        refresh()
    }

    private fun switchMode() {
        release()
        relative = !relative
        resetPointer()
        refresh()
    }

    private fun resetPointer() = DeskFleetBridge.nativeTouch(14, 0.0, 0.0, 0.0, 0.0)

    private fun toggleKeyboard() {
        if (!input.enabled) return
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

    private fun toggleHacker() {
        if (!input.enabled) return
        input.clearModifiers()
        hacker.visibility = if (hacker.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        refreshModifiers()
        root.post { clampToolbar() }
    }

    private fun buildHackerKeyboard() {
        val heading = TextView(context).apply {
            text = "Hacker Keyboard"
            setTextColor(Color.WHITE)
            textSize = 13f
            gravity = Gravity.CENTER_VERTICAL
        }
        hacker.addView(LinearLayout(context).apply {
            addView(heading, LinearLayout.LayoutParams(0, dp(44), 1f))
            addView(button("⌨", "System keyboard") { toggleKeyboard() })
            addView(button("✕", "Close Hacker Keyboard") { toggleHacker() })
        })
        val keyRows = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        hacker.addView(ScrollView(context).apply { addView(keyRows) }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        fun key(title: String, code: String) = button(title, title) { input.stroke(code); refreshModifiers() }.also(inputButtons::add)
        fun keys(vararg entries: Pair<String, String>) {
            keyRows.addView(HorizontalScrollView(context).apply {
                isHorizontalScrollBarEnabled = false
                addView(row(*entries.map { key(it.first, it.second) }.toTypedArray()))
            })
        }
        val modifiers = row(*listOf("Ctrl" to "ControlLeft", "Alt" to "AltLeft", "Shift" to "ShiftLeft", "Meta" to "MetaLeft").map { (title, code) ->
            button(title, title) { input.toggleModifier(code); refreshModifiers() }.also { modifierButtons[code] = it; inputButtons.add(it) }
        }.toTypedArray())
        modifiers.addView(key("Esc", "Escape"))
        modifiers.addView(key("Tab", "Tab"))
        keyRows.addView(HorizontalScrollView(context).apply { addView(modifiers) })
        keys("←" to "ArrowLeft", "↓" to "ArrowDown", "↑" to "ArrowUp", "→" to "ArrowRight", "⌫" to "Backspace", "↵" to "Enter")
        keys("Home" to "Home", "End" to "End", "PgUp" to "PageUp", "PgDn" to "PageDown", "Ins" to "Insert", "Del" to "Delete")
        keys(*((1..12).map { "F$it" to "F$it" }.toTypedArray()))
        keys("A" to "KeyA", "C" to "KeyC", "V" to "KeyV", "X" to "KeyX", "Z" to "KeyZ", "Space" to "Space")
        keyRows.addView(TextView(context).apply {
            text = "Ctrl / Alt / Shift / Meta + key"
            setTextColor(Color.LTGRAY)
            textSize = 11f
            setPadding(dp(8), dp(4), dp(8), dp(4))
        })
    }

    private fun showDisplays() {
        release()
        val displays = state.optJSONArray("displays") ?: return
        val choices = (0 until displays.length()).map { displays.getJSONObject(it) }
        AlertDialog.Builder(context).setTitle(label("Displays", "显示器"))
            .setSingleChoiceItems(choices.map {
                it.optString("name").ifBlank { "${label("Display", "显示器")} ${it.optInt("displayNumber", it.optInt("id"))}" }
            }.toTypedArray(), choices.indexOfFirst { it.optInt("id") == state.optInt("displayId") }) { dialog, index ->
                release()
                emit(JSONObject().put("type", "selectDisplay").put("displayId", choices[index].getInt("id")))
                dialog.dismiss()
            }.setNegativeButton(label("Cancel", "取消"), null).show()
    }

    private fun showSettings() {
        release()
        val choices = mutableListOf(label("Mouse and keyboard control", "鼠标和键盘控制"), label("Reverse scroll", "反向滚动"), label("Clipboard sharing", "共享剪贴板"))
        val checked = mutableListOf(state.optBoolean("control"), reverseScroll, clipboardSharing)
        if (input.pasteCode != "MetaLeft") {
            choices.add(label("Terminal text input (Ctrl+Shift+V)", "终端文本输入（Ctrl+Shift+V）"))
            checked.add(input.pasteShift)
        }
        AlertDialog.Builder(context).setTitle(label("Control settings", "控制设置"))
            .setMultiChoiceItems(choices.toTypedArray(), checked.toBooleanArray()) { _, which, selected ->
                when (which) {
                    0 -> emit(JSONObject().put("type", "setControl").put("control", selected))
                    1 -> reverseScroll = selected
                    2 -> clipboardSharing = selected
                    3 -> input.pasteShift = selected
                }
            }
            .setNeutralButton(label("Full screen", "全屏")) { _, _ -> toggleFullscreen() }
            .setPositiveButton(label("Done", "完成"), null)
            .apply {
                if (state.optBoolean("secureAttention") && input.enabled) {
                    setNegativeButton("Ctrl+Alt+Del") { _, _ -> input.secureAttention() }
                }
            }.show()
    }

    private fun refresh() {
        mode.text = if (relative) label("Relative", "相对鼠标") else label("Absolute", "绝对鼠标")
        mode.contentDescription = label("Switch absolute / relative mouse mode", "切换绝对 / 相对鼠标模式")
        mode.isSelected = relative
        fold.text = if (expanded) "−" else "+"
        rows.visibility = if (expanded) View.VISIBLE else View.GONE
        pause.text = if (paused) "▶" else "Ⅱ"
        pause.contentDescription = if (paused) label("Resume input", "恢复控制") else label("Pause input", "暂停控制")
        pause.isEnabled = available()
        pause.alpha = if (pause.isEnabled) 1f else 0.4f
        connectionButton.text = if (connected()) "⏻" else "↻"
        connectionButton.contentDescription = if (connected()) label("Disconnect", "断开连接") else label("Reconnect", "重新连接")
        displayButton.isEnabled = (state.optJSONArray("displays")?.length() ?: 0) > 0
        keyboardButton.contentDescription = label("System keyboard", "系统键盘")
        keyboardButton.isSelected = imeVisible
        for (button in inputButtons + keyboardButton + hackerButton) {
            button.isEnabled = input.enabled
            button.alpha = if (input.enabled) 1f else 0.4f
        }
        val hint = if (relative) label("Slide to move · double-tap and hold to drag · hold for right-click", "滑动移动 · 双击按住拖动 · 长按右键")
            else label("Tap to click · slide to drag · two fingers to scroll", "轻点单击 · 滑动拖动 · 双指滚动")
        status.text = state.optString("settingsError").ifBlank { state.optString("error") }.ifBlank {
            if (!connected()) state.optString("status", label("Connecting", "连接中")) else hint
        }
        refreshModifiers()
        toolbar.post { clampToolbar() }
    }

    private fun refreshModifiers() {
        modifierButtons.forEach { (code, view) ->
            view.setTextColor(if (code in input.modifiers) Color.CYAN else Color.WHITE)
            view.isSelected = code in input.modifiers
        }
    }

    private fun row(vararg views: View) = LinearLayout(context).apply { views.forEach(::addView) }
    private fun button(title: String, description: String, click: () -> Unit) = TextView(context).apply {
        text = title
        contentDescription = description
        setTextColor(Color.WHITE)
        textSize = 13f
        minWidth = dp(44)
        minHeight = dp(44)
        gravity = Gravity.CENTER
        setPadding(dp(8), 0, dp(8), 0)
        isClickable = true
        setOnClickListener { click() }
        val attrs = context.obtainStyledAttributes(intArrayOf(android.R.attr.selectableItemBackgroundBorderless))
        background = attrs.getDrawable(0)
        attrs.recycle()
    }

    private fun panelBackground() = GradientDrawable().apply {
        cornerRadius = dp(14).toFloat()
        setColor(Color.argb(235, 24, 27, 34))
        setStroke(dp(1), Color.argb(80, 255, 255, 255))
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun makeDraggable() {
        var downX = 0f; var downY = 0f; var startX = 0f; var startY = 0f
        grip.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    release()
                    downX = event.rawX; downY = event.rawY; startX = toolbar.x; startY = toolbar.y
                }
                MotionEvent.ACTION_MOVE -> {
                    toolbar.x = startX + event.rawX - downX; toolbar.y = startY + event.rawY - downY
                    clampToolbar()
                }
                MotionEvent.ACTION_UP -> grip.performClick()
            }
            true
        }
    }

    private fun clampToolbar() {
        if (root.width == 0 || toolbar.width == 0) return
        val left = safe.left + dp(8)
        val top = safe.top + dp(8)
        val right = (root.width - safe.right - toolbar.width - dp(8)).coerceAtLeast(left)
        val bottom = (root.height - safe.bottom - toolbar.height - dp(8)).coerceAtLeast(top)
        toolbar.x = toolbar.x.coerceIn(left.toFloat(), right.toFloat())
        toolbar.y = toolbar.y.coerceIn(top.toFloat(), bottom.toFloat())
        val width = (root.width - safe.left - safe.right - dp(16)).coerceAtLeast(1)
        if (toolbar.minimumWidth != width.coerceAtMost(dp(280))) toolbar.minimumWidth = width.coerceAtMost(dp(280))
    }

    private fun LinearLayout.maximumHeight(available: Int) {
        val scroller = getChildAt(1) ?: return
        val height = (available / 2 - dp(44)).coerceIn(dp(44), dp(260))
        if (scroller.layoutParams.height != height) {
            scroller.layoutParams = scroller.layoutParams.apply { this.height = height }
        }
    }

    private fun dp(value: Int) = (value * context.resources.displayMetrics.density).toInt()
}
