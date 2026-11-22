package io.github.yet_another_ai.deskfleet.nativedesktop

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RemoteDesktopInputTest {
    private fun input(sent: MutableList<String>) = RemoteDesktopInput(sent::add) { events ->
        events.forEach { sent.add(JSONObject().put("type", "input").put("event", it).toString()) }
    }

    @Test
    fun `disabled controls never send keys or committed text`() {
        val sent = mutableListOf<String>()
        val input = input(sent)
        input.stroke("Tab")
        input.text("中文")
        input.toggleModifier("ControlLeft")
        assertTrue(sent.isEmpty())
    }

    @Test
    fun `Hacker modifiers combine with one key and then release`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.toggleModifier("ControlLeft")
        input.toggleModifier("ShiftLeft")
        assertTrue("Selecting Hacker modifiers must not alter remote clicks", sent.isEmpty())
        input.stroke("KeyZ")
        val keys = sent.map { JSONObject(it).getJSONObject("event") }
        assertEquals(listOf("ControlLeft", "ShiftLeft", "KeyZ", "KeyZ", "ShiftLeft", "ControlLeft"), keys.map { it.getString("code") })
        assertEquals(listOf(true, true, true, false, false, false), keys.map { it.getBoolean("pressed") })
        assertTrue(input.modifiers.isEmpty())
    }

    @Test
    fun `shortcut chords release everything first and unwind in reverse`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.toggleModifier("AltLeft")
        input.chord(listOf("ControlLeft", "ShiftLeft", "Escape"))
        val events = sent.map { JSONObject(it).getJSONObject("event") }
        assertEquals("releaseAll", events.first().getString("type"))
        val keys = events.drop(1)
        assertEquals(listOf("ControlLeft", "ShiftLeft", "Escape", "Escape", "ShiftLeft", "ControlLeft"), keys.map { it.getString("code") })
        assertEquals(listOf(true, true, true, false, false, false), keys.map { it.getBoolean("pressed") })
        assertTrue("A chord replaces pending Hacker modifiers", input.modifiers.isEmpty())
    }

    @Test
    fun `committed unicode uses target platform paste and removes NUL`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true; pasteCode = "MetaLeft" }
        input.text("中文\u0000🙂")
        val command = JSONObject(sent.single())
        assertEquals("text", command.getString("type"))
        assertEquals("中文🙂", command.getString("text"))
        assertEquals("MetaLeft", command.getString("pasteCode"))
    }

    @Test
    fun `IME letter with Ctrl is a physical shortcut and return is Enter`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.toggleModifier("ControlLeft")
        input.text("c")
        input.text("\n")
        val keys = sent.map { JSONObject(it).getJSONObject("event") }
        assertEquals(listOf("ControlLeft", "KeyC", "KeyC", "ControlLeft", "Enter", "Enter"), keys.map { it.getString("code") })
    }

    @Test
    fun `pause clears modifiers and releases held keys before refusing input`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.toggleModifier("AltLeft")
        input.enabled = false
        input.stroke("Tab")
        assertEquals(1, sent.size)
        assertEquals("releaseAll", JSONObject(sent.last()).getJSONObject("event").getString("type"))
        assertTrue(input.modifiers.isEmpty())
    }

    @Test
    fun `empty and oversized commits produce no transport message`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.text("")
        input.text("\u0000")
        input.text("中".repeat(11_000))
        assertTrue(sent.isEmpty())
    }

    @Test
    fun `terminal text mode requests shifted paste chord`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true; pasteShift = true }
        input.text("ls")
        val command = JSONObject(sent.single())
        assertEquals("ControlLeft", command.getString("pasteCode"))
        assertTrue(command.getBoolean("pasteShift"))
    }

    @Test
    fun `opening IME releases held keys while retaining the next shortcut`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.key("ArrowLeft", true)
        input.toggleModifier("ControlLeft")
        input.release(preserveModifiers = true)
        assertEquals(setOf("ControlLeft"), input.modifiers)
        assertEquals("releaseAll", JSONObject(sent.last()).getJSONObject("event").getString("type"))
        sent.clear()
        input.text("c")
        assertEquals(listOf("ControlLeft", "KeyC", "KeyC", "ControlLeft"),
            sent.map { JSONObject(it).getJSONObject("event").getString("code") })
        assertTrue(input.modifiers.isEmpty())
    }

    @Test
    fun `pending modifier wraps a repeating hardware key until its release`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.toggleModifier("AltLeft")
        input.key("ArrowLeft", true)
        input.key("ArrowLeft", true, repeat = true)
        input.key("ArrowLeft", false)
        input.key("KeyA", true)
        input.key("KeyA", false)
        val keys = sent.map { JSONObject(it).getJSONObject("event") }
        assertEquals(listOf("AltLeft", "ArrowLeft", "ArrowLeft", "ArrowLeft", "AltLeft", "KeyA", "KeyA"), keys.map { it.getString("code") })
        assertEquals(listOf(true, true, true, false, false, true, false), keys.map { it.getBoolean("pressed") })
        assertTrue(keys[2].getBoolean("repeat"))
    }

    @Test
    fun `one shot shortcut does not release a physically held modifier`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.key("ControlLeft", true)
        input.toggleModifier("ControlLeft")
        input.stroke("KeyC")
        input.key("ControlLeft", false)
        val keys = sent.map { JSONObject(it).getJSONObject("event") }
        assertEquals(listOf("ControlLeft", "KeyC", "KeyC", "ControlLeft"), keys.map { it.getString("code") })
        assertEquals(listOf(true, true, false, false), keys.map { it.getBoolean("pressed") })
    }

    @Test
    fun `Android chord recovers right Control and left Alt without duplicate edges`() {
        val batches = mutableListOf<List<JSONObject>>()
        val input = RemoteDesktopInput({}, batches::add).apply { enabled = true }
        val ctrl = android.view.KeyEvent.META_CTRL_RIGHT_ON
        val alt = android.view.KeyEvent.META_ALT_LEFT_ON
        input.hardwareKey("AltLeft", true, false, alt)
        input.hardwareKey("KeyC", true, false, ctrl or alt)
        input.hardwareKey("KeyC", true, true, ctrl or alt)
        input.hardwareKey("KeyC", false, false, ctrl or alt)
        input.hardwareKey("ControlRight", false, false, alt)
        input.hardwareKey("AltLeft", false, false, 0)
        assertEquals(listOf("ControlRight", "KeyC"), batches[1].map { it.getString("code") })
        assertEquals(listOf("AltLeft", "ControlRight", "KeyC", "KeyC", "KeyC", "ControlRight", "AltLeft"),
            batches.flatten().map { it.getString("code") })
        assertEquals(listOf(true, true, true, true, false, false, false),
            batches.flatten().map { it.getBoolean("pressed") })
        assertTrue(batches[2].single().getBoolean("repeat"))
    }

    @Test
    fun `release drops stale repeat and up from the previous focus`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.hardwareKey("KeyA", true, false, android.view.KeyEvent.META_SHIFT_RIGHT_ON)
        input.release()
        sent.clear()
        input.hardwareKey("KeyA", true, true, android.view.KeyEvent.META_SHIFT_RIGHT_ON)
        input.hardwareKey("KeyA", false, false, 0)
        assertTrue(sent.isEmpty())
        input.hardwareKey("KeyB", true, false, android.view.KeyEvent.META_META_RIGHT_ON)
        assertEquals(listOf("MetaRight", "KeyB"), sent.map { JSONObject(it).getJSONObject("event").getString("code") })
    }

    @Test
    fun `opposite side release resolves an initially unsided Control flag`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.hardwareKey("KeyC", true, false, android.view.KeyEvent.META_CTRL_ON)
        input.hardwareKey("KeyC", false, false, android.view.KeyEvent.META_CTRL_ON)
        assertTrue(input.ownsHardwareKey("ControlRight"))
        input.hardwareKey("ControlRight", false, false, 0)
        assertFalse(input.ownsHardwareKey("ControlLeft"))
        assertFalse(input.ownsHardwareKey("ControlRight"))
        val keys = sent.map { JSONObject(it).getJSONObject("event") }
        assertEquals(listOf("ControlLeft", "KeyC", "KeyC", "ControlLeft"), keys.map { it.getString("code") })
        assertEquals(listOf(true, true, false, false), keys.map { it.getBoolean("pressed") })
    }
}
