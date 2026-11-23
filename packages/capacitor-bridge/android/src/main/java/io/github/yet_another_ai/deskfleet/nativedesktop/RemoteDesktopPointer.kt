package io.github.yet_another_ai.deskfleet.nativedesktop

import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewConfiguration

internal fun MotionEvent.isDesktopPointer() = isFromSource(InputDevice.SOURCE_MOUSE) ||
    isFromSource(InputDevice.SOURCE_TOUCHPAD) || getToolType(0) == MotionEvent.TOOL_TYPE_MOUSE

/** Touch and generic motion dispatch carry different parts of the same mouse gesture. */
internal class RemoteDesktopPointer(private val controls: RemoteDesktopControls) {
    private val surface = controls.surface
    private val location = IntArray(2)
    private val config = ViewConfiguration.get(surface.context)
    private val capture = PointerCapture()
    private var overVideo = false
    private var downX = 0.0
    private var downY = 0.0

    fun reset() {
        capture.reset()
        overVideo = false
    }

    // Android also synthesizes navigation KeyEvents for mouse back/forward buttons.
    fun handlesNavigation(event: KeyEvent) = controls.input.enabled && (capture.video ?: overVideo) &&
        (event.isFromSource(InputDevice.SOURCE_MOUSE) || event.isFromSource(InputDevice.SOURCE_TOUCHPAD)) &&
        (event.keyCode == KeyEvent.KEYCODE_BACK || event.keyCode == KeyEvent.KEYCODE_FORWARD)

    fun dispatch(event: MotionEvent): Boolean {
        if (!event.isDesktopPointer()) return false
        surface.getLocationInWindow(location)
        val x = event.x - location[0]
        val y = event.y - location[1]
        val action = event.actionMasked
        overVideo = action != MotionEvent.ACTION_HOVER_EXIT &&
            x >= 0 && y >= 0 && x < surface.width && y < surface.height && !controls.hitTest(x, y)
        val buttons = event.buttonState and 0x1f
        val begin = capture.starts(action)
        val deferredPress = capture.deferredPress(action, buttons)
        val remote = capture.route(action, buttons, overVideo && controls.input.enabled)
        if (!remote || !controls.input.enabled) return false
        if ((begin || deferredPress || action == MotionEvent.ACTION_BUTTON_PRESS) && buttons and 0x1e != 0) {
            controls.input.beforePaste()
        }
        val direction = if (controls.reverseScroll) -1.0 else 1.0
        val scale = direction / surface.resources.displayMetrics.density
        val px = x.toDouble()
        val py = y.toDouble()

        if (action == MotionEvent.ACTION_DOWN) {
            // During a precision scroll Android moves a synthetic finger under the
            // stationary mouse cursor. Keep wheel events on the initial target.
            downX = px
            downY = py
        }
        if (action == MotionEvent.ACTION_SCROLL) {
            val dx = event.getAxisValue(MotionEvent.AXIS_HSCROLL) * config.scaledHorizontalScrollFactor
            val dy = -event.getAxisValue(MotionEvent.AXIS_VSCROLL) * config.scaledVerticalScrollFactor
            DeskFleetBridge.nativeTouch(5, px, py, dx * scale, dy * scale)
        } else if (event.classification == MotionEvent.CLASSIFICATION_TWO_FINGER_SWIPE) {
            // API 34 precision touchpads report scroll distances in display pixels.
            var dx = event.getAxisValue(MotionEvent.AXIS_GESTURE_SCROLL_X_DISTANCE)
            var dy = event.getAxisValue(MotionEvent.AXIS_GESTURE_SCROLL_Y_DISTANCE)
            for (sample in 0 until event.historySize) {
                dx += event.getHistoricalAxisValue(MotionEvent.AXIS_GESTURE_SCROLL_X_DISTANCE, sample)
                dy += event.getHistoricalAxisValue(MotionEvent.AXIS_GESTURE_SCROLL_Y_DISTANCE, sample)
            }
            if (dx != 0f || dy != 0f)
                DeskFleetBridge.nativeTouch(5, downX, downY, dx * scale, dy * scale)
        } else if (event.classification != MotionEvent.CLASSIFICATION_PINCH) {
            when {
                (begin || deferredPress) && buttons != 0 -> {
                    controls.focusVideo()
                    // Some devices announce the mask after DOWN. Hit-test the
                    // original press against the video before applying its motion.
                    val originX = if (deferredPress) downX else px
                    val originY = if (deferredPress) downY else py
                    DeskFleetBridge.nativePointer(1, buttons, originX, originY)
                    if (px != originX || py != originY) DeskFleetBridge.nativePointer(2, buttons, px, py)
                }
                action == MotionEvent.ACTION_CANCEL ||
                    ((action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_BUTTON_RELEASE) && buttons == 0) ->
                    DeskFleetBridge.nativePointer(3, 0, px, py)
                action == MotionEvent.ACTION_MOVE && buttons == 0 && capture.video == null ->
                    DeskFleetBridge.nativePointer(0, 0, px, py)
                action == MotionEvent.ACTION_MOVE || action == MotionEvent.ACTION_UP ||
                    action == MotionEvent.ACTION_BUTTON_PRESS || action == MotionEvent.ACTION_BUTTON_RELEASE ->
                    DeskFleetBridge.nativePointer(2, buttons, px, py)
                action == MotionEvent.ACTION_HOVER_ENTER || action == MotionEvent.ACTION_HOVER_MOVE ->
                    DeskFleetBridge.nativePointer(0, 0, px, py)
            }
        }
        // Let Android clear the old NSH hover target when the cursor returns to the video.
        return action != MotionEvent.ACTION_HOVER_ENTER && action != MotionEvent.ACTION_HOVER_MOVE
    }
}

/** A chord stays on its original target across control boundaries and generic button events. */
internal class PointerCapture {
    var video: Boolean? = null
        private set

    private var touchStream = false
    private var awaitingButtons = false

    fun deferredPress(action: Int, buttons: Int) = awaitingButtons && buttons != 0 &&
        (action == MotionEvent.ACTION_BUTTON_PRESS || action == MotionEvent.ACTION_MOVE)

    fun reset() {
        video = null
        touchStream = false
        awaitingButtons = false
    }

    fun starts(action: Int) = when (action) {
        MotionEvent.ACTION_DOWN -> video == null || touchStream
        MotionEvent.ACTION_BUTTON_PRESS -> video == null
        else -> false
    }

    fun route(action: Int, buttons: Int, overVideo: Boolean): Boolean {
        if (starts(action)) {
            video = overVideo
            awaitingButtons = action == MotionEvent.ACTION_DOWN && buttons == 0
        }
        if (buttons != 0) awaitingButtons = false
        if (action == MotionEvent.ACTION_DOWN) touchStream = true
        val target = video ?: overVideo
        if (action == MotionEvent.ACTION_UP) touchStream = false
        if (action == MotionEvent.ACTION_CANCEL || (!touchStream && buttons == 0 &&
            (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_BUTTON_RELEASE))) reset()
        return target
    }
}
