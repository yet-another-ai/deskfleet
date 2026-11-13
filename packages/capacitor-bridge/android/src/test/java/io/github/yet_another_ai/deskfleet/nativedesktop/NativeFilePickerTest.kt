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

    @Test
    fun closingBeforeTheUiQueueRunsCancelsWithoutLaunchingOrRejecting() {
        val picker = NativeFilePicker<String>()
        val tasks = mutableListOf<() -> Unit>()
        val request = picker.begin("account", "call")
        val settled = mutableListOf<String>()
        var launches = 0
        picker.schedule(request, { tasks.add(it) }, { launches++; {} }, { settled.add("rejected") })

        picker.cancel("account")?.let { settled.add("${it.value}:cancelled") }
        assertEquals(listOf("call:cancelled"), settled)
        tasks.single().invoke()
        assertEquals(0, launches)
        assertEquals(listOf("call:cancelled"), settled)
        assertNull(picker.cancel("account"))
        val reopened = picker.begin("account", "reopened")
        assertSame(reopened, picker.finish(reopened))
    }

    @Test
    fun queuedOldLaunchCannotTouchAReplacementUsingTheSameEndpointId() {
        val picker = NativeFilePicker<String>()
        val tasks = mutableListOf<() -> Unit>()
        val launched = mutableListOf<String>()
        val settled = mutableListOf<String>()
        val old = picker.begin("endpoint", "old")
        picker.schedule(old, { tasks.add(it) }, { launched.add("old"); {} }, { settled.add("old:failed") })
        picker.cancel("endpoint")?.let { settled.add("${it.value}:cancelled") }

        val replacement = picker.begin("endpoint", "replacement")
        picker.schedule(replacement, { tasks.add(it) }, { launched.add("replacement"); {} }, { settled.add("replacement:failed") })
        tasks[0]()
        assertTrue(launched.isEmpty())
        assertEquals(listOf("old:cancelled"), settled)
        assertThrows(IllegalStateException::class.java) { picker.begin("endpoint", "duplicate") }

        tasks[1]()
        assertEquals(listOf("replacement"), launched)
        assertNull(picker.finish(old))
        picker.finish(replacement)?.let { settled.add("${it.value}:selected") }
        assertEquals(listOf("old:cancelled", "replacement:selected"), settled)
    }

    @Test
    fun queuedLaunchFailureRejectsOnceAndReleasesTheReservation() {
        val picker = NativeFilePicker<String>()
        val tasks = mutableListOf<() -> Unit>()
        val request = picker.begin("account", "failed")
        val failures = mutableListOf<String?>()
        picker.schedule(request, { tasks.add(it) }, { throw IllegalStateException("launch failed") }, { failures.add(it.message) })

        tasks.single().invoke()
        tasks.single().invoke()
        assertEquals(listOf("launch failed"), failures)
        assertNull(picker.finish(request))
        val retry = picker.begin("account", "retry")
        assertSame(retry, picker.finish(retry))
    }

    @Test
    fun aDispatchFailureRejectsTheReservedRequestAndAllowsRetry() {
        val picker = NativeFilePicker<String>()
        val request = picker.begin("account", "call")
        val failures = mutableListOf<String?>()
        var launches = 0
        picker.schedule(request, { throw IllegalStateException("dispatch failed") }, { launches++; {} }, { failures.add(it.message) })

        assertEquals(listOf("dispatch failed"), failures)
        assertEquals(0, launches)
        assertNull(picker.finish(request))
        val retry = picker.begin("account", "retry")
        assertSame(retry, picker.finish(retry))
    }

    @Test
    fun aDispatchFailureCannotRejectAnAlreadyCancelledRequest() {
        val picker = NativeFilePicker<String>()
        val request = picker.begin("account", "call")
        val settled = mutableListOf<String>()
        picker.schedule(
            request,
            dispatch = {
                picker.cancel("account")?.let { settled.add("cancelled") }
                throw IllegalStateException("dispatch failed after cancellation")
            },
            launch = { throw AssertionError("Cancelled request launched") },
            failed = { settled.add("rejected") },
        )
        assertEquals(listOf("cancelled"), settled)
    }

    @Test
    fun aQueuedTaskCannotLaunchTheSameRequestTwice() {
        val picker = NativeFilePicker<String>()
        val tasks = mutableListOf<() -> Unit>()
        val request = picker.begin("account", "call")
        var launches = 0
        var releases = 0
        picker.schedule(request, { tasks.add(it) }, { launches++; { releases++ } }, { throw AssertionError(it) })

        tasks.single().invoke()
        tasks.single().invoke()
        assertEquals(1, launches)
        picker.finish(request)
        tasks.single().invoke()
        assertEquals(1, launches)
        assertEquals(1, releases)
    }
}
