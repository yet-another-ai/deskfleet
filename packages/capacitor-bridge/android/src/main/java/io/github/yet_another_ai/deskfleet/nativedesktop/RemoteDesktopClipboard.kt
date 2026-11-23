package io.github.yet_another_ai.deskfleet.nativedesktop

import org.json.JSONObject

/** Marshals host observations; sanitization, baseline and dedup live in Rust. */
internal class RemoteDesktopClipboard(
    private val policy: ClipboardPolicyBridge = NativeClipboard(),
) : AutoCloseable {
    fun resetSession() {
        policy.update("""{"operation":"reset"}""")
    }

    fun takeFocusCommand(rawText: CharSequence?, enabled: Boolean, sharing: Boolean): String? =
        takeLocalCommand("focus", rawText, enabled, sharing)

    fun takeOutgoingCommand(rawText: CharSequence?, enabled: Boolean, sharing: Boolean, explicit: Boolean = false): String? =
        takeLocalCommand(if (explicit) "explicit" else "changed", rawText, enabled, sharing)

    fun takePasteCommand(rawText: CharSequence?, enabled: Boolean, sharing: Boolean): String? =
        takeLocalCommand("paste", rawText, enabled, sharing)

    private fun takeLocalCommand(intent: String, rawText: CharSequence?, enabled: Boolean, sharing: Boolean): String? {
        val text = policy.update(JSONObject()
            .put("operation", "local")
            .put("intent", intent)
            .put("inputEnabled", enabled)
            .put("sharing", sharing)
            .put("text", rawText?.toString() ?: JSONObject.NULL)
            .toString()) ?: return null
        return JSONObject().put("type", "clipboard").put("text", text).toString()
    }

    fun acceptIncomingEvent(payload: String, enabled: Boolean, sharing: Boolean): String? {
        val event = runCatching { JSONObject(payload) }.getOrNull() ?: return null
        if (event.optString("type") != "clipboard") return null
        val text = event.opt("text") as? String ?: return null
        return policy.update(JSONObject()
            .put("operation", "remote")
            .put("inputEnabled", enabled)
            .put("sharing", sharing)
            .put("text", text)
            .toString())
    }

    override fun close() = policy.close()
}
