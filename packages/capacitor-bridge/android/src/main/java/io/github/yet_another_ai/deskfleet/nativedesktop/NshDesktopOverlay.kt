package io.github.yet_another_ai.deskfleet.nativedesktop

import android.content.Context
import android.view.MotionEvent
import com.longbridge.nsh.NshView

/** Only the shared controls own input; transparent space falls through to the video surface. */
internal class NshDesktopOverlay(
    context: Context,
    private val containsControls: (Float, Float) -> Boolean,
    private val dragToolbar: (MotionEvent) -> Boolean,
) : NshView(context) {
    private var tracking = false
    private var dragging = false

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            dragging = dragToolbar(event)
            tracking = dragging || containsControls(event.x, event.y)
            if (!tracking) return false
            if (dragging) return true
        }
        if (!tracking) return false
        if (dragging) dragToolbar(event) else super.dispatchTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            tracking = false
            dragging = false
        }
        // Whitespace inside a control panel must not click the remote desktop.
        return true
    }
}
