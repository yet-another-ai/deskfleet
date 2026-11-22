package io.github.yet_another_ai.deskfleet.nativedesktop

import android.view.KeyEvent
import org.json.JSONObject

/** Mobile input state; the Rust peer independently checks acknowledged control permission. */
internal class RemoteDesktopInput(
    private val send: (String) -> Unit,
    private val sendSequence: (List<JSONObject>) -> Unit,
) {
    var enabled = false
        set(value) {
            if (field && !value) release()
            field = value
        }
    var pasteCode = "ControlLeft"
    var pasteShift = false
    // Hacker modifiers apply to the next key; selecting one must not modify remote mouse clicks.
    val modifiers = linkedSetOf<String>()
    private val hardwareKeys = mutableSetOf<String>()
    private val inferredLeft = mutableSetOf<String>()
    private val hardwareModifiers = linkedSetOf<String>()
    private val keyChords = mutableMapOf<String, List<String>>()

    fun toggleModifier(code: String) {
        if (!enabled) return
        if (!modifiers.remove(code)) modifiers.add(code)
    }

    // A generic meta flag uses the left position until Android reports its side.
    fun ownsHardwareKey(code: String) = code in hardwareKeys || code in hardwareModifiers ||
        ANDROID_MODIFIERS.any { code == it.right && it.left in inferredLeft }

    /** Android can deliver a modified key without its initial modifier-down after a focus change. */
    fun hardwareKey(code: String, pressed: Boolean, repeat: Boolean, metaState: Int) {
        if (!enabled) return
        if ((!pressed || repeat) && !ownsHardwareKey(code)) return
        val events = buildList {
            for ((both, leftFlag, rightFlag, left, right) in ANDROID_MODIFIERS) {
                val sides = metaState and (leftFlag or rightFlag)
                if (code == left || code == right) {
                    if (inferredLeft.remove(left) && code == right && sides and leftFlag == 0) {
                        appendKey(left, false)
                    }
                    continue
                }
                val unspecified = sides == 0 && metaState and both != 0
                val wantRight = sides and rightFlag != 0 || (unspecified && right in hardwareModifiers)
                val wantLeft = sides and leftFlag != 0 || (unspecified && (!wantRight || left in hardwareModifiers))
                if (!unspecified) inferredLeft.remove(left)
                else if (wantLeft && left !in hardwareModifiers) inferredLeft.add(left)
                if ((left in hardwareModifiers) != wantLeft) appendKey(left, wantLeft)
                if ((right in hardwareModifiers) != wantRight) appendKey(right, wantRight)
            }
            if (code in MODIFIER_KEYS) {
                appendKey(code, pressed)
            } else if (pressed) {
                if (hardwareKeys.add(code) || repeat) appendKey(code, true, repeat)
            } else if (hardwareKeys.remove(code)) {
                appendKey(code, false)
            }
        }
        if (events.isNotEmpty()) sendSequence(events)
    }

    fun key(code: String, pressed: Boolean, repeat: Boolean = false) {
        if (enabled) sendSequence(buildList { appendKey(code, pressed, repeat) })
    }

    private fun MutableList<JSONObject>.appendKey(code: String, pressed: Boolean, repeat: Boolean = false) {
        if (code in MODIFIER_KEYS) {
            val wasHeld = modifierHeld(code)
            if (pressed) hardwareModifiers.add(code) else hardwareModifiers.remove(code)
            val held = modifierHeld(code)
            if (wasHeld != held) add(keyEvent(code, held))
            return
        }
        if (pressed && !repeat && code !in keyChords && modifiers.isNotEmpty()) {
            val chord = modifiers.toList()
            val newlyHeld = chord.filterNot(::modifierHeld)
            keyChords[code] = chord
            modifiers.clear()
            newlyHeld.forEach { add(keyEvent(it, true)) }
        }
        add(keyEvent(code, pressed, repeat))
        if (!pressed) keyChords.remove(code)?.asReversed()?.forEach {
            if (!modifierHeld(it)) add(keyEvent(it, false))
        }
    }

    fun stroke(code: String) {
        if (!enabled) return
        sendSequence(buildList {
            appendKey(code, true)
            appendKey(code, false)
        })
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
            // The native paste batch releases the viewer's held keys.
            clearHolds(false)
            send(JSONObject().put("type", "text").put("text", text).put("pasteCode", pasteCode)
                .put("pasteShift", pasteShift).toString())
        }
    }

    /** Sends one whole shortcut: earlier codes stay held while the last is tapped. */
    fun chord(codes: List<String>) {
        if (!enabled || codes.isEmpty()) return
        clearHolds(false)
        sendSequence(buildList {
            add(JSONObject().put("type", "releaseAll"))
            codes.forEach { add(keyEvent(it, true)) }
            codes.asReversed().forEach { add(keyEvent(it, false)) }
        })
    }

    fun secureAttention() {
        if (enabled) event(JSONObject().put("type", "secureAttention"))
    }

    fun clearModifiers() {
        modifiers.clear()
    }

    fun release(preserveModifiers: Boolean = false) {
        clearHolds(preserveModifiers)
        event(JSONObject().put("type", "releaseAll"))
    }

    private fun clearHolds(preserveModifiers: Boolean) {
        if (!preserveModifiers) modifiers.clear()
        hardwareKeys.clear()
        inferredLeft.clear()
        hardwareModifiers.clear()
        keyChords.clear()
    }

    private fun modifierHeld(code: String) = code in hardwareModifiers || keyChords.values.any { code in it }

    private fun keyEvent(code: String, pressed: Boolean, repeat: Boolean = false): JSONObject =
        JSONObject().put("type", "key").put("code", code).put("pressed", pressed).put("repeat", repeat)

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

    private data class Modifier(val any: Int, val leftMask: Int, val rightMask: Int, val left: String, val right: String)

    companion object {
        private val ANDROID_MODIFIERS = listOf(
            Modifier(KeyEvent.META_CTRL_ON, KeyEvent.META_CTRL_LEFT_ON, KeyEvent.META_CTRL_RIGHT_ON, "ControlLeft", "ControlRight"),
            Modifier(KeyEvent.META_ALT_ON, KeyEvent.META_ALT_LEFT_ON, KeyEvent.META_ALT_RIGHT_ON, "AltLeft", "AltRight"),
            Modifier(KeyEvent.META_SHIFT_ON, KeyEvent.META_SHIFT_LEFT_ON, KeyEvent.META_SHIFT_RIGHT_ON, "ShiftLeft", "ShiftRight"),
            Modifier(KeyEvent.META_META_ON, KeyEvent.META_META_LEFT_ON, KeyEvent.META_META_RIGHT_ON, "MetaLeft", "MetaRight"),
        )
        private val MODIFIER_KEYS = ANDROID_MODIFIERS.flatMap { listOf(it.left, it.right) }.toSet()
    }
}
