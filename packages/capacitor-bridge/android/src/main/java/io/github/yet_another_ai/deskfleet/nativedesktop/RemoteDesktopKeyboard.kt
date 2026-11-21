package io.github.yet_another_ai.deskfleet.nativedesktop

import android.content.Context
import android.text.InputType
import android.text.SpannableStringBuilder
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager

/** A real Android text editor lets every installed IME compose locally before committing remotely. */
internal class RemoteDesktopKeyboard(context: Context, private val input: RemoteDesktopInput) : View(context) {
    private var clearComposition: () -> Unit = {}
    var onInput: () -> Unit = {}

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        contentDescription = "Remote desktop keyboard"
    }

    override fun onCheckIsTextEditor() = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN or
            EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or EditorInfo.IME_ACTION_NONE
        outAttrs.initialSelStart = 0
        outAttrs.initialSelEnd = 0
        return object : BaseInputConnection(this, true) {
            private val buffer = SpannableStringBuilder()
            init { clearComposition = { buffer.clear(); removeComposingSpans(buffer) } }
            override fun getEditable() = buffer

            override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                text?.toString()?.let(input::text)
                buffer.clear()
                removeComposingSpans(buffer)
                onInput()
                return true
            }

            override fun finishComposingText(): Boolean {
                if (buffer.isNotEmpty()) input.text(buffer.toString())
                buffer.clear()
                removeComposingSpans(buffer)
                onInput()
                return true
            }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                if (buffer.isNotEmpty()) return super.deleteSurroundingText(beforeLength, afterLength)
                repeat(beforeLength.coerceIn(0, 128)) { input.stroke("Backspace") }
                repeat(afterLength.coerceIn(0, 128)) { input.stroke("Delete") }
                onInput()
                return true
            }

            override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
                if (buffer.isNotEmpty()) return super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
                return deleteSurroundingText(beforeLength, afterLength)
            }

            override fun sendKeyEvent(event: KeyEvent): Boolean = handleKey(event) || super.sendKeyEvent(event)

            override fun performEditorAction(actionCode: Int): Boolean {
                input.stroke("Enter")
                onInput()
                return true
            }

            override fun closeConnection() {
                // Closing or hiding an IME cancels an uncommitted composition.
                buffer.clear()
                super.closeConnection()
            }
        }
    }

    fun cancelComposition() {
        clearComposition()
        if (hasFocus()) context.getSystemService(InputMethodManager::class.java)?.restartInput(this)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean = handleKey(event) || super.onKeyDown(keyCode, event)
    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean = handleKey(event) || super.onKeyUp(keyCode, event)

    private fun handleKey(event: KeyEvent): Boolean {
        val code = when (event.keyCode) {
            in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> "Key${('A'.code + event.keyCode - KeyEvent.KEYCODE_A).toChar()}"
            in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> "Digit${event.keyCode - KeyEvent.KEYCODE_0}"
            in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 -> "F${event.keyCode - KeyEvent.KEYCODE_F1 + 1}"
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "Enter"
            KeyEvent.KEYCODE_DEL -> "Backspace"
            KeyEvent.KEYCODE_FORWARD_DEL -> "Delete"
            KeyEvent.KEYCODE_TAB -> "Tab"
            KeyEvent.KEYCODE_ESCAPE -> "Escape"
            KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
            KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
            KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
            KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
            KeyEvent.KEYCODE_MOVE_HOME -> "Home"
            KeyEvent.KEYCODE_MOVE_END -> "End"
            KeyEvent.KEYCODE_PAGE_UP -> "PageUp"
            KeyEvent.KEYCODE_PAGE_DOWN -> "PageDown"
            KeyEvent.KEYCODE_CTRL_LEFT -> "ControlLeft"
            KeyEvent.KEYCODE_CTRL_RIGHT -> "ControlRight"
            KeyEvent.KEYCODE_ALT_LEFT -> "AltLeft"
            KeyEvent.KEYCODE_ALT_RIGHT -> "AltRight"
            KeyEvent.KEYCODE_SHIFT_LEFT -> "ShiftLeft"
            KeyEvent.KEYCODE_SHIFT_RIGHT -> "ShiftRight"
            KeyEvent.KEYCODE_META_LEFT -> "MetaLeft"
            KeyEvent.KEYCODE_META_RIGHT -> "MetaRight"
            KeyEvent.KEYCODE_SPACE -> "Space"
            KeyEvent.KEYCODE_MINUS -> "Minus"
            KeyEvent.KEYCODE_EQUALS -> "Equal"
            KeyEvent.KEYCODE_LEFT_BRACKET -> "BracketLeft"
            KeyEvent.KEYCODE_RIGHT_BRACKET -> "BracketRight"
            KeyEvent.KEYCODE_BACKSLASH -> "Backslash"
            KeyEvent.KEYCODE_SEMICOLON -> "Semicolon"
            KeyEvent.KEYCODE_APOSTROPHE -> "Quote"
            KeyEvent.KEYCODE_COMMA -> "Comma"
            KeyEvent.KEYCODE_PERIOD -> "Period"
            KeyEvent.KEYCODE_SLASH -> "Slash"
            KeyEvent.KEYCODE_GRAVE -> "Backquote"
            else -> return false
        }
        if (event.action != KeyEvent.ACTION_DOWN && event.action != KeyEvent.ACTION_UP) return false
        input.key(code, event.action == KeyEvent.ACTION_DOWN, event.repeatCount > 0)
        onInput()
        return true
    }
}
