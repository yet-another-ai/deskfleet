package io.github.yet_another_ai.deskfleet.nativedesktop

internal class RemoteDesktopClipboard {
    private var lastSynced: String? = null

    @Synchronized
    fun takeOutgoingCommand(rawText: CharSequence?): String? {
        val text = rawText?.toString()?.replace("\u0000", "") ?: return null
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (text.isEmpty() || bytes.size > MAX_CLIPBOARD_BYTES || text == lastSynced) {
            return null
        }
        lastSynced = text
        return encodeClipboardCommand(text)
    }

    @Synchronized
    fun acceptIncomingEvent(payload: String): String? {
        val text = decodeClipboardEvent(payload)?.replace("\u0000", "") ?: return null
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (text.isEmpty() || bytes.size > MAX_CLIPBOARD_BYTES || text == lastSynced) {
            return null
        }
        lastSynced = text
        return text
    }

    companion object {
        const val MAX_CLIPBOARD_BYTES = 32 * 1024

        internal fun encodeClipboardCommand(text: String): String {
            val sb = StringBuilder(text.length + 32)
            sb.append("""{"type":"clipboard","text":"""")
            for (ch in text) {
                when (ch) {
                    '\\' -> sb.append("\\\\")
                    '"' -> sb.append("\\\"")
                    '\b' -> sb.append("\\b")
                    '\u000C' -> sb.append("\\f")
                    '\n' -> sb.append("\\n")
                    '\r' -> sb.append("\\r")
                    '\t' -> sb.append("\\t")
                    else -> if (ch.code < 0x20) {
                        sb.append(String.format("\\u%04x", ch.code))
                    } else {
                        sb.append(ch)
                    }
                }
            }
            sb.append("\"}")
            return sb.toString()
        }

        internal fun decodeClipboardEvent(payload: String): String? {
            if (!payload.contains("\"type\":\"clipboard\"") && !payload.contains("\"type\": \"clipboard\"")) {
                return null
            }
            val keyIndex = payload.indexOf("\"text\"")
            if (keyIndex < 0) return null
            var i = payload.indexOf(':', keyIndex + 6)
            if (i < 0) return null
            i++
            while (i < payload.length && payload[i].isWhitespace()) i++
            if (i >= payload.length || payload[i] != '"') return null
            i++
            val out = StringBuilder()
            while (i < payload.length) {
                val c = payload[i++]
                if (c == '"') return out.toString()
                if (c != '\\') {
                    out.append(c)
                    continue
                }
                if (i >= payload.length) return null
                when (val esc = payload[i++]) {
                    '"', '\\', '/' -> out.append(esc)
                    'b' -> out.append('\b')
                    'f' -> out.append('\u000C')
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    'u' -> {
                        if (i + 4 > payload.length) return null
                        val code = payload.substring(i, i + 4).toIntOrNull(16) ?: return null
                        out.append(code.toChar())
                        i += 4
                    }
                    else -> return null
                }
            }
            return null
        }
    }
}
