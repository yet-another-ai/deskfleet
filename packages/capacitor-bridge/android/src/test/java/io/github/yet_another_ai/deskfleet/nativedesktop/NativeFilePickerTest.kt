package io.github.yet_another_ai.deskfleet.nativedesktop

import org.junit.Assert.*
import org.junit.Test

class NativeFilePickerTest {
    @Test
    fun closingAnAccountReleasesItsPickerWithoutWaitingForAnActivityResult() {
        val picker = NativeFilePicker<String>()
        val previous = picker.begin("old-account", "old-call")
        var releases = 0
        previous.unregister = { releases++ }

        assertSame(previous, picker.cancel("old-account"))
        assertEquals(1, releases)
        val next = picker.begin("new-account", "new-call")
        assertSame(next, picker.finish(next))
        assertEquals(1, releases)
    }

    @Test
    fun aLateOldResultCannotResolveOrClearAReplacementPicker() {
        val picker = NativeFilePicker<String>()
        val previous = picker.begin("old-account", "old-call")
        picker.cancel("old-account")
        val next = picker.begin("new-account", "new-call")
        var releases = 0
        next.unregister = { releases++ }

        // Each Android callback captures its request, even after another launch updates
        // Capacitor's unrelated lastPluginCallId or the old PluginCall is released.
        assertNull(picker.finish(previous))
        assertEquals(0, releases)
        assertThrows(IllegalStateException::class.java) { picker.begin("new-account", "duplicate") }
        assertEquals("new-call", picker.finish(next)?.value)
        assertEquals(1, releases)
    }

    @Test
    fun aCancelledActivityResultClearsTheCurrentPickerAndAllowsReopening() {
        val picker = NativeFilePicker<String>()
        val cancelled = picker.begin("account", "cancelled-call")
        // Completion is independent of a URI or a nullable Capacitor PluginCall.
        assertSame(cancelled, picker.finish(cancelled))
        val reopened = picker.begin("account", "reopened-call")
        assertSame(reopened, picker.finish(reopened))
    }

    @Test
    fun launchFailureReleasesTheReservationAndAllowsAnotherAttempt() {
        val picker = NativeFilePicker<String>()
        val failed = picker.begin("account", "failed-call")
        picker.finish(failed)
        val retry = picker.begin("account", "retry-call")
        assertSame(retry, picker.finish(retry))
    }

    @Test
    fun closingAnotherEndpointCannotCancelTheActivePicker() {
        val picker = NativeFilePicker<String>()
        val active = picker.begin("active-account", "active-call")
        assertNull(picker.cancel("other-account"))
        assertSame(active, picker.finish(active))
    }

    @Test
    fun duplicateResultsAndRepeatedCloseReleaseTheRouteOnlyOnce() {
        val picker = NativeFilePicker<String>()
        val request = picker.begin("account", "call")
        var releases = 0
        request.unregister = { releases++ }
        picker.finish(request)
        assertNull(picker.finish(request))
        assertNull(picker.cancel("account"))
        assertEquals(1, releases)
    }
}
