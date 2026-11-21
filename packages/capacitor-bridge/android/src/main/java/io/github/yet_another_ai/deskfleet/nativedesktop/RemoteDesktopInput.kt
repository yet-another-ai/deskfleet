package io.github.yet_another_ai.deskfleet.nativedesktop

import org.json.JSONObject

/** Mobile input state; the Rust peer independently checks acknowledged control permission. */
internal class RemoteDesktopInput(private val send: (String) -> Unit) {
    var enabled = false
        set(value) {
            if (field && !value) release()
            field = value
        }
    var pasteCode = "ControlLeft"
    var pasteShift = false
    val modifiers = linkedSetOf<String>()

    fun toggleModifier(code: String) {
        if (!enabled) return
        val pressed = if (modifiers.remove(code)) false else { modifiers.add(code); true }
        key(code, pressed)
    }

    fun key(code: String, pressed: Boolean, repeat: Boolean = false) {
        if (!enabled) return
        event(JSONObject().put("type", "key").put("code", code).put("pressed", pressed).put("repeat", repeat))
    }

    fun stroke(code: String) {
        if (!enabled) return
        key(code, true)
        key(code, false)
        clearModifiers()
    }

    fun text(value: String) {
        if (!enabled) return
        val text = value.replace("\u0000", "")
        if (text.isEmpty() || text.toByteArray(Charsets.UTF_8).size > RemoteDesktopClipboard.MAX_CLIPBOARD_BYTES) return
        if (text == "\n" || text == "\r" || text == "\r\n") { stroke("Enter"); return }
        if (text == "\t") { stroke("Tab"); return }
        val shortcutCode = if (text.length == 1) physicalCode(text[0]) else null
        if (modifiers.isNotEmpty() && shortcutCode != null) {
            stroke(shortcutCode)
        } else {
            clearModifiers()
            send(JSONObject().put("type", "text").put("text", text).put("pasteCode", pasteCode)
                .put("pasteShift", pasteShift).toString())
        }
    }

    fun secureAttention() {
        if (enabled) event(JSONObject().put("type", "secureAttention"))
    }

    fun clearModifiers() {
        modifiers.toList().forEach { key(it, false) }
        modifiers.clear()
    }

    fun release() {
        modifiers.clear()
        event(JSONObject().put("type", "releaseAll"))
    }

    private fun event(event: JSONObject) {
        send(JSONObject().put("type", "input").put("event", event).toString())
    }

    private fun physicalCode(char: Char): String? = when {
        char.isLetter() && char.code < 128 -> "Key${char.uppercaseChar()}"
        char in '0'..'9' -> "Digit$char"
        else -> when (char) {
            ' ' -> "Space"
            '\n', '\r' -> "Enter"
            '\t' -> "Tab"
            '-', '_' -> "Minus"
            '=', '+' -> "Equal"
            '[', '{' -> "BracketLeft"
            ']', '}' -> "BracketRight"
            '\\', '|' -> "Backslash"
            ';', ':' -> "Semicolon"
            '\'', '"' -> "Quote"
            ',', '<' -> "Comma"
            '.', '>' -> "Period"
            '/', '?' -> "Slash"
            '`', '~' -> "Backquote"
            else -> null
        }
    }
}
