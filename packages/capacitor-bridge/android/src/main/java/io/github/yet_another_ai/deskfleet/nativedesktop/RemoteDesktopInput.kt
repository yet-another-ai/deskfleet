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
    // Hacker modifiers apply to the next key; selecting one must not modify remote mouse clicks.
    val modifiers = linkedSetOf<String>()
    private val hardwareModifiers = linkedSetOf<String>()
    private val keyChords = mutableMapOf<String, List<String>>()

    fun toggleModifier(code: String) {
        if (!enabled) return
        if (!modifiers.remove(code)) modifiers.add(code)
    }

    fun key(code: String, pressed: Boolean, repeat: Boolean = false) {
        if (!enabled) return
        if (code in MODIFIER_KEYS) {
            val wasHeld = modifierHeld(code)
            if (pressed) hardwareModifiers.add(code) else hardwareModifiers.remove(code)
            val held = modifierHeld(code)
            if (wasHeld != held) sendKey(code, held)
            return
        }
        if (pressed && !repeat && code !in keyChords && modifiers.isNotEmpty()) {
            val chord = modifiers.toList()
            val newlyHeld = chord.filterNot(::modifierHeld)
            keyChords[code] = chord
            modifiers.clear()
            newlyHeld.forEach { sendKey(it, true) }
        }
        sendKey(code, pressed, repeat)
        if (!pressed) keyChords.remove(code)?.asReversed()?.forEach {
            if (!modifierHeld(it)) sendKey(it, false)
        }
    }

    fun stroke(code: String) {
        if (!enabled) return
        key(code, true)
        key(code, false)
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
            // The native text command releases held keys before its paste chord.
            hardwareModifiers.clear()
            keyChords.clear()
            send(JSONObject().put("type", "text").put("text", text).put("pasteCode", pasteCode)
                .put("pasteShift", pasteShift).toString())
        }
    }

    /** Sends one whole shortcut: earlier codes stay held while the last is tapped. */
    fun chord(codes: List<String>) {
        if (!enabled || codes.isEmpty()) return
        release()
        codes.forEach { sendKey(it, true) }
        codes.asReversed().forEach { sendKey(it, false) }
    }

    fun secureAttention() {
        if (enabled) event(JSONObject().put("type", "secureAttention"))
    }

    fun clearModifiers() {
        modifiers.clear()
    }

    fun release(preserveModifiers: Boolean = false) {
        if (!preserveModifiers) modifiers.clear()
        hardwareModifiers.clear()
        keyChords.clear()
        event(JSONObject().put("type", "releaseAll"))
    }

    private fun modifierHeld(code: String) = code in hardwareModifiers || keyChords.values.any { code in it }

    private fun sendKey(code: String, pressed: Boolean, repeat: Boolean = false) {
        event(JSONObject().put("type", "key").put("code", code).put("pressed", pressed).put("repeat", repeat))
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

    companion object {
        private val MODIFIER_KEYS = setOf("ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight")
    }
}
