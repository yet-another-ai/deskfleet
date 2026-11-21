package io.github.yet_another_ai.deskfleet.nativedesktop

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RemoteDesktopInputTest {
    @Test
    fun `disabled controls never send keys or committed text`() {
        val sent = mutableListOf<String>()
        val input = RemoteDesktopInput(sent::add)
        input.stroke("Tab")
        input.text("中文")
        input.toggleModifier("ControlLeft")
        assertTrue(sent.isEmpty())
    }

    @Test
    fun `Hacker modifiers combine with one key and then release`() {
        val sent = mutableListOf<String>()
        val input = RemoteDesktopInput(sent::add).apply { enabled = true }
        input.toggleModifier("ControlLeft")
        input.toggleModifier("ShiftLeft")
        input.stroke("KeyZ")
        val keys = sent.map { JSONObject(it).getJSONObject("event") }
        assertEquals(listOf("ControlLeft", "ShiftLeft", "KeyZ", "KeyZ", "ControlLeft", "ShiftLeft"), keys.map { it.getString("code") })
        assertEquals(listOf(true, true, true, false, false, false), keys.map { it.getBoolean("pressed") })
        assertTrue(input.modifiers.isEmpty())
    }

    @Test
    fun `committed unicode uses target platform paste and removes NUL`() {
        val sent = mutableListOf<String>()
        val input = RemoteDesktopInput(sent::add).apply { enabled = true; pasteCode = "MetaLeft" }
        input.text("中文\u0000🙂")
        val command = JSONObject(sent.single())
        assertEquals("text", command.getString("type"))
        assertEquals("中文🙂", command.getString("text"))
        assertEquals("MetaLeft", command.getString("pasteCode"))
    }

    @Test
    fun `IME letter with Ctrl is a physical shortcut and return is Enter`() {
        val sent = mutableListOf<String>()
        val input = RemoteDesktopInput(sent::add).apply { enabled = true }
        input.toggleModifier("ControlLeft")
        input.text("c")
        input.text("\n")
        val keys = sent.map { JSONObject(it).getJSONObject("event") }
        assertEquals(listOf("ControlLeft", "KeyC", "KeyC", "ControlLeft", "Enter", "Enter"), keys.map { it.getString("code") })
    }

    @Test
    fun `pause clears modifiers and releases held keys before refusing input`() {
        val sent = mutableListOf<String>()
        val input = RemoteDesktopInput(sent::add).apply { enabled = true }
        input.toggleModifier("AltLeft")
        input.enabled = false
        input.stroke("Tab")
        assertEquals(2, sent.size)
        assertEquals("releaseAll", JSONObject(sent.last()).getJSONObject("event").getString("type"))
        assertTrue(input.modifiers.isEmpty())
    }

    @Test
    fun `empty and oversized commits produce no transport message`() {
        val sent = mutableListOf<String>()
        val input = RemoteDesktopInput(sent::add).apply { enabled = true }
        input.text("")
        input.text("\u0000")
        input.text("中".repeat(11_000))
        assertTrue(sent.isEmpty())
    }

    @Test
    fun `terminal text mode requests shifted paste chord`() {
        val sent = mutableListOf<String>()
        val input = RemoteDesktopInput(sent::add).apply { enabled = true; pasteShift = true }
        input.text("ls")
        val command = JSONObject(sent.single())
        assertEquals("ControlLeft", command.getString("pasteCode"))
        assertTrue(command.getBoolean("pasteShift"))
    }
}
