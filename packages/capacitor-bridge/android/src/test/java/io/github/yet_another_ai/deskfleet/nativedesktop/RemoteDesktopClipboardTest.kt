package io.github.yet_another_ai.deskfleet.nativedesktop

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RemoteDesktopClipboardTest {
    @Test
    fun deduplicatesOutgoingAndIncomingClipboardPayloads() {
        val sync = RemoteDesktopClipboard()
        // First focus seeds baseline without overwriting remote clipboard.
        assertNull(sync.takeFocusCommand("initial clip"))
        assertNull(sync.takeFocusCommand("initial clip"))
        // Explicit button tap or primary-clip change can still send the seeded text.
        assertEquals(
            """{"type":"clipboard","text":"initial clip"}""",
            sync.takeOutgoingCommand("initial clip"),
        )
        // New text observed on subsequent window focus is sent once.
        assertEquals(
            """{"type":"clipboard","text":"focused clip"}""",
            sync.takeFocusCommand("focused clip"),
        )
        assertNull(sync.takeFocusCommand("focused clip"))

        val cmd = sync.takeOutgoingCommand("hello\n\"world\"")
        assertEquals("""{"type":"clipboard","text":"hello\n\"world\""}""", cmd)
        // Duplicate outgoing text is suppressed.
        assertNull(sync.takeOutgoingCommand("hello\n\"world\""))
        // Echo from remote is also suppressed.
        assertNull(sync.acceptIncomingEvent(cmd!!))

        // Fresh incoming remote clipboard text is accepted once.
        val incoming = """{"type":"clipboard","text":"remote \u2713"}"""
        assertEquals("remote ✓", sync.acceptIncomingEvent(incoming))
        assertNull(sync.acceptIncomingEvent(incoming))
        // Local clipboard change callback or focus echoing that remote write is suppressed.
        assertNull(sync.takeOutgoingCommand("remote ✓"))
        assertNull(sync.takeFocusCommand("remote ✓"))
    }

    @Test
    fun rejectsEmptyAndOversizedClipboardPayloads() {
        val sync = RemoteDesktopClipboard()
        assertNull(sync.takeOutgoingCommand(null))
        assertNull(sync.takeOutgoingCommand(""))
        assertNull(sync.takeOutgoingCommand("\u0000"))
        val oversized = "a".repeat(RemoteDesktopClipboard.MAX_CLIPBOARD_BYTES + 1)
        assertNull(sync.takeOutgoingCommand(oversized))
        assertNull(sync.acceptIncomingEvent("""{"type":"clipboard","text":"$oversized"}"""))
        assertNull(sync.acceptIncomingEvent("""{"type":"ready"}"""))
    }
}
