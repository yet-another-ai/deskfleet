package io.github.yet_another_ai.deskfleet.nativedesktop

import android.view.MotionEvent
import org.junit.Assert.*
import org.junit.Test

class RemoteDesktopPointerTest {
    @Test fun firstNonzeroMaskAfterButtonlessDownUsesTheOriginalTarget() {
        for (video in listOf(true, false)) {
            val capture = PointerCapture()
            assertEquals(video, capture.route(MotionEvent.ACTION_DOWN, 0, video))
            assertTrue(capture.deferredPress(MotionEvent.ACTION_BUTTON_PRESS, 2))
            assertEquals(video, capture.route(MotionEvent.ACTION_BUTTON_PRESS, 2, !video))
            assertFalse(capture.deferredPress(MotionEvent.ACTION_BUTTON_PRESS, 3))
        }
    }

    @Test fun localClickKeepsItsUpEventWhenReleasedOverVideo() {
        val capture = PointerCapture()
        assertFalse(capture.route(MotionEvent.ACTION_DOWN, 1, false))
        assertFalse(capture.route(MotionEvent.ACTION_BUTTON_PRESS, 1, false))
        assertFalse(capture.route(MotionEvent.ACTION_MOVE, 1, true))
        assertFalse(capture.route(MotionEvent.ACTION_BUTTON_RELEASE, 0, true))
        assertFalse(capture.route(MotionEvent.ACTION_UP, 0, true))
        assertTrue(capture.route(MotionEvent.ACTION_HOVER_MOVE, 0, true))
    }

    @Test fun remoteChordRetainsGenericButtonsAcrossTheEndOfTouchDispatch() {
        val capture = PointerCapture()
        assertTrue(capture.route(MotionEvent.ACTION_BUTTON_PRESS, 8, true))
        assertTrue(capture.route(MotionEvent.ACTION_DOWN, 10, false))
        assertTrue(capture.route(MotionEvent.ACTION_BUTTON_PRESS, 10, false))
        assertTrue(capture.route(MotionEvent.ACTION_BUTTON_RELEASE, 8, false))
        assertTrue(capture.route(MotionEvent.ACTION_UP, 8, false))
        assertTrue(capture.route(MotionEvent.ACTION_BUTTON_RELEASE, 0, false))
        assertFalse(capture.route(MotionEvent.ACTION_HOVER_MOVE, 0, false))
    }
}
