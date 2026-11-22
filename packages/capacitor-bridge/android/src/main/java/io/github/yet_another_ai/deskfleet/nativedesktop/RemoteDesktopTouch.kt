package io.github.yet_another_ai.deskfleet.nativedesktop

import android.annotation.SuppressLint
import android.os.SystemClock
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.SurfaceView

internal class RemoteDesktopTouch(private val surface: SurfaceView, private val controls: RemoteDesktopControls) {
    private var dragging = false
    private var active = false
    private var multiTouch = false
    private var longPressed = false
    /** A pinch owns the rest of its gesture, so it never also scrolls the remote. */
    private var pinching = false
    private var lastX = 0.0
    private var lastY = 0.0
    private val detector = GestureDetector(surface.context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true

        override fun onSingleTapUp(e: MotionEvent): Boolean {
            if (!multiTouch && !longPressed && !controls.dragging) touch(if (controls.relative) 9 else 3, e)
            return true
        }

        override fun onLongPress(e: MotionEvent) {
            if (!multiTouch && !dragging && !controls.dragging && controls.input.enabled) {
                longPressed = true
                touch(if (controls.relative) 10 else 4, e)
            }
        }

        override fun onDoubleTap(e: MotionEvent) = true

        override fun onDoubleTapEvent(e: MotionEvent): Boolean {
            if (e.actionMasked == MotionEvent.ACTION_DOWN && !controls.dragging) {
                dragging = true
                touch(if (controls.relative) 11 else 1, e)
            }
            if (e.actionMasked == MotionEvent.ACTION_MOVE) {
                if (controls.relative) DeskFleetBridge.nativeTouch(8, 0.0, 0.0, e.x - lastX, e.y - lastY)
                else touch(0, e)
            }
            return true
        }

        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
            if (pinching) return true
            if (e2.pointerCount >= 2) {
                multiTouch = true
                endDrag()
                controls.stopDrag()
                val scale = (if (controls.reverseScroll) -1.0 else 1.0) / surface.resources.displayMetrics.density
                DeskFleetBridge.nativeTouch(if (controls.relative) 13 else 5, e2.x.toDouble(), e2.y.toDouble(), dx * scale, dy * scale)
            } else if (!multiTouch && !longPressed) {
                if (controls.relative) {
                    DeskFleetBridge.nativeTouch(8, 0.0, 0.0, -dx.toDouble(), -dy.toDouble())
                } else {
                    if (!dragging && e1 != null) { dragging = true; touch(1, e1) }
                    touch(0, e2)
                }
            }
            return true
        }
    })

    // Pinch zoom is local presentation; Rust maps later touches through the zoomed video.
    private val scale = ScaleGestureDetector(surface.context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
            if (!controls.pinchZoom || !controls.connected()) return false
            pinching = true
            multiTouch = true
            endDrag()
            return true
        }

        override fun onScale(detector: ScaleGestureDetector): Boolean {
            DeskFleetBridge.nativeTouch(15, detector.focusX.toDouble(), detector.focusY.toDouble(), detector.scaleFactor.toDouble(), 0.0)
            return true
        }

        override fun onScaleEnd(detector: ScaleGestureDetector) {
            DeskFleetBridge.nativeTouch(16, 0.0, 0.0, 0.0, 0.0)
        }
    }).apply {
        // Double-tap-and-hold drags the remote pointer; it must not also zoom.
        isQuickScaleEnabled = false
    }

    @SuppressLint("ClickableViewAccessibility")
    fun attach() {
        surface.setOnTouchListener { _, event ->
            if (event.isDesktopPointer()) return@setOnTouchListener false
            if (event.actionMasked == MotionEvent.ACTION_DOWN) pinching = false
            if (controls.pinchZoom && controls.connected()) scale.onTouchEvent(event)
            if (!controls.input.enabled) { reset(); return@setOnTouchListener true }
            if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                active = true
                controls.focusVideo()
                multiTouch = false
                longPressed = false
                lastX = event.x.toDouble(); lastY = event.y.toDouble()
            }
            // A focus/mode change ends this gesture even if the finger is still down.
            if (!active) return@setOnTouchListener true
            if (event.pointerCount >= 2) multiTouch = true
            detector.onTouchEvent(event)
            lastX = event.x.toDouble(); lastY = event.y.toDouble()
            if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
                endDrag()
                active = false
            }
            if (event.actionMasked == MotionEvent.ACTION_CANCEL) controls.release()
            true
        }
    }

    fun reset() {
        active = false
        val now = SystemClock.uptimeMillis()
        val cancel = MotionEvent.obtain(now, now, MotionEvent.ACTION_CANCEL, 0f, 0f, 0)
        try {
            // Also removes GestureDetector's delayed long-press and double-tap messages.
            detector.onTouchEvent(cancel)
        } finally {
            cancel.recycle()
        }
        dragging = false
        multiTouch = false
        longPressed = false
    }

    private fun endDrag() {
        if (!dragging) return
        dragging = false
        DeskFleetBridge.nativeTouch(if (controls.relative) 12 else 2, lastX, lastY, 0.0, 0.0)
    }

    private fun touch(kind: Int, event: MotionEvent) =
        DeskFleetBridge.nativeTouch(kind, event.x.toDouble(), event.y.toDouble(), 0.0, 0.0)
}
