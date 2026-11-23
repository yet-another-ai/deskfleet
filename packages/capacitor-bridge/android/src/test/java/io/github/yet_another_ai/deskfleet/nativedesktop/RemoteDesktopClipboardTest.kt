package io.github.yet_another_ai.deskfleet.nativedesktop

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteDesktopClipboardTest {
    private class RecordingPolicy : ClipboardPolicyBridge {
        val requests = mutableListOf<JSONObject>()
        var result: String? = null
        var closed = false
        override fun update(request: String): String? {
            requests.add(JSONObject(request))
            return result
        }
        override fun close() { closed = true }
    }

    @Test
    fun forwardsRawTextPermissionsAndIntentToRust() {
        val native = RecordingPolicy()
        val sync = RemoteDesktopClipboard(native)
        val raw = "你好\u0000\n\"quote\"\\path"
        assertNull(sync.takeFocusCommand(raw, enabled = false, sharing = true))
        assertNull(sync.takeOutgoingCommand(raw, enabled = true, sharing = false, explicit = true))
        assertNull(sync.takeOutgoingCommand(raw, enabled = true, sharing = true))
        assertNull(sync.takePasteCommand(raw, enabled = true, sharing = false))
        assertEquals(listOf("focus", "explicit", "changed", "paste"), native.requests.map { it.getString("intent") })
        assertTrue(native.requests.all { it.getString("text") == raw && it.getString("operation") == "local" })
        assertFalse(native.requests[0].getBoolean("inputEnabled"))
        assertFalse(native.requests[1].getBoolean("sharing"))
        assertTrue(native.requests[2].getBoolean("sharing"))
    }

    @Test
    fun sendsOnlyTextAcceptedByRustUsingProperJsonEscaping() {
        val native = RecordingPolicy()
        val sync = RemoteDesktopClipboard(native)
        assertNull(sync.takeOutgoingCommand("raw", enabled = true, sharing = true))
        native.result = "accepted\n\"✓\"\\path"
        val command = JSONObject(sync.takeOutgoingCommand("raw", enabled = true, sharing = true)!!)
        assertEquals("clipboard", command.getString("type"))
        assertEquals(native.result, command.getString("text"))
    }

    @Test
    fun representsAnUnavailableOsClipboardAsNull() {
        val native = RecordingPolicy()
        RemoteDesktopClipboard(native).takeFocusCommand(null, enabled = true, sharing = true)
        assertTrue(native.requests.single().isNull("text"))
    }

    @Test
    fun decodesIncomingEventThenDelegatesPolicyToRust() {
        val native = RecordingPolicy().also { it.result = "accepted" }
        val sync = RemoteDesktopClipboard(native)
        val raw = "remote\u0000\n✓"
        val event = JSONObject().put("text", raw).put("type", "clipboard").toString(2)
        assertEquals("accepted", sync.acceptIncomingEvent(event, enabled = false, sharing = false))
        val request = native.requests.single()
        assertEquals("remote", request.getString("operation"))
        assertEquals(raw, request.getString("text"))
        assertFalse(request.getBoolean("inputEnabled"))
        assertFalse(request.getBoolean("sharing"))
    }

    @Test
    fun ignoresMalformedOrUnrelatedIncomingEvents() {
        val native = RecordingPolicy()
        val sync = RemoteDesktopClipboard(native)
        for (payload in listOf("invalid", """{"type":"ready"}""", """{"type":"clipboard","text":12}""", """{"type":"clipboard"}""")) {
            assertNull(sync.acceptIncomingEvent(payload, enabled = true, sharing = true))
        }
        assertTrue(native.requests.isEmpty())
    }

    @Test
    fun sessionResetAndCloseReachTheNativeOwner() {
        val native = RecordingPolicy()
        val sync = RemoteDesktopClipboard(native)
        sync.resetSession()
        assertEquals("reset", native.requests.single().getString("operation"))
        sync.close()
        assertTrue(native.closed)
    }
}
