package io.github.yet_another_ai.deskfleet.nativedesktop

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RemoteDesktopInputTest {
    private fun input(sent: MutableList<String>) = RemoteDesktopInput(sent::add) { events ->
        events.forEach { sent.add(JSONObject().put("type", "input").put("event", it).toString()) }
    }

    private fun RemoteDesktopInput.selectModifiers(vararg codes: String) {
        setModifiers(listOf("ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft").map { it in codes })
    }

    @Test
    fun `disabled controls never send keys or committed text`() {
        val sent = mutableListOf<String>()
        val input = input(sent)
        input.stroke("Tab")
        input.text("中文")
        input.chord(listOf("ControlLeft", "KeyC"))
        assertTrue(sent.isEmpty())
    }

    @Test
    fun `Hacker modifiers combine with one key and then release`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.selectModifiers("ControlLeft", "ShiftLeft")
        assertTrue("Selecting Hacker modifiers must not alter remote clicks", sent.isEmpty())
        input.stroke("KeyZ")
        val keys = sent.map { JSONObject(it).getJSONObject("event") }
        assertEquals(listOf("ControlLeft", "ShiftLeft", "KeyZ", "KeyZ", "ShiftLeft", "ControlLeft"), keys.map { it.getString("code") })
        assertEquals(listOf(true, true, true, false, false, false), keys.map { it.getBoolean("pressed") })
        assertTrue(input.modifiers.isEmpty())
    }

    @Test
    fun `modifier effects replace selection in Ctrl Alt Shift Meta order without remote input`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.key("AltRight", true)
        sent.clear()
        input.setModifiers(listOf(true, true, true, true))
        assertEquals(listOf("ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft"), input.modifiers.toList())
        input.setModifiers(listOf(false, false, true, false))
        assertEquals(setOf("ShiftLeft"), input.modifiers)
        assertTrue(sent.isEmpty())
        assertTrue("Replacing one-shot selection preserves physical modifiers", input.ownsHardwareKey("AltRight"))
    }

    @Test
    fun `ordered chord releases once and unwinds in reverse`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.hardwareKey("KeyA", true, false, android.view.KeyEvent.META_ALT_RIGHT_ON)
        input.selectModifiers("AltLeft")
        sent.clear()
        input.chord(listOf("ControlLeft", "ShiftLeft", "Escape"))
        val events = sent.map { JSONObject(it).getJSONObject("event") }
        assertEquals("releaseAll", events.first().getString("type"))
        val keys = events.drop(1)
        assertEquals(listOf("ControlLeft", "ShiftLeft", "Escape", "Escape", "ShiftLeft", "ControlLeft"), keys.map { it.getString("code") })
        assertEquals(listOf(true, true, true, false, false, false), keys.map { it.getBoolean("pressed") })
        assertTrue("A chord replaces pending Hacker modifiers", input.modifiers.isEmpty())
        input.hardwareKey("KeyA", true, true, android.view.KeyEvent.META_ALT_RIGHT_ON)
        input.hardwareKey("KeyA", false, false, 0)
        assertEquals("The ordered release also clears stale hardware ownership", 7, sent.size)
    }

    @Test
    fun `committed unicode uses target platform paste and delegates sanitizing to Rust`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true; pasteCode = "MetaLeft" }
        input.text("中文\u0000🙂")
        val command = JSONObject(sent.single())
        assertEquals("text", command.getString("type"))
        assertEquals("中文\u0000🙂", command.getString("text"))
        assertEquals("MetaLeft", command.getString("pasteCode"))
    }

    @Test
    fun `paste callback precedes chord and IME key batches but not text commits`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true; beforePaste = { sent.add("clipboard") } }
        input.chord(listOf("MetaLeft", "KeyV"))
        assertEquals("clipboard", sent.first())
        assertEquals("releaseAll", JSONObject(sent[1]).getJSONObject("event").getString("type"))
        assertEquals(1, sent.count { it == "clipboard" })
        sent.clear()
        input.selectModifiers("ControlLeft")
        input.text("v")
        assertEquals("clipboard", sent.first())
        sent.clear()
        input.text("raw\u0000 text")
        assertEquals("raw\u0000 text", JSONObject(sent.single()).getString("text"))
    }

    @Test
    fun `paste callback runs on fresh hardware or IME paste keys only`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true; beforePaste = { sent.add("clipboard") } }
        input.hardwareKey("KeyV", true, false, android.view.KeyEvent.META_CTRL_RIGHT_ON)
        assertEquals("clipboard", sent.first())
        sent.clear()
        input.hardwareKey("KeyV", true, true, android.view.KeyEvent.META_CTRL_RIGHT_ON)
        input.hardwareKey("KeyV", false, false, 0)
        assertFalse(sent.contains("clipboard"))
        sent.clear()
        input.key("Insert", true)
        assertEquals("clipboard", sent.first())
        sent.clear()
        input.key("Insert", true, repeat = true)
        input.key("Insert", false)
        assertFalse(sent.contains("clipboard"))
        sent.clear()
        input.enabled = false
        input.chord(listOf("ControlLeft", "KeyV"))
        input.hardwareKey("KeyV", true, false, android.view.KeyEvent.META_CTRL_ON)
        input.text("v")
        assertTrue(sent.isEmpty())
    }

    @Test
    fun `IME letter with Ctrl is a physical shortcut and return is Enter`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.selectModifiers("ControlLeft")
        input.text("c")
        input.text("\n")
        val keys = sent.map { JSONObject(it).getJSONObject("event") }
        assertEquals(listOf("ControlLeft", "KeyC", "KeyC", "ControlLeft", "Enter", "Enter"), keys.map { it.getString("code") })
    }

    @Test
    fun `pause effects release before disabling without an extra release`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.selectModifiers("AltLeft")
        input.release()
        input.enabled = false
        input.stroke("Tab")
        assertEquals(1, sent.size)
        assertEquals("releaseAll", JSONObject(sent.last()).getJSONObject("event").getString("type"))
        assertTrue(input.modifiers.isEmpty())
    }

    @Test
    fun `empty commits are ignored and raw commits reach Rust validation`() {
        val sent = mutableListOf<String>()
        val input = input(sent).apply { enabled = true }
        input.text("")
        assertTrue(sent.isEmpty())
        input.text("\u0000")
        input.text("中".repeat(11_000))
        assertEquals(listOf("\u0000", "中".repeat(11_000)), sent.map { JSONObject(it).getString("text") })
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
        input.selectModifiers("ControlLeft")
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
        input.selectModifiers("AltLeft")
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
        input.selectModifiers("ControlLeft")
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
