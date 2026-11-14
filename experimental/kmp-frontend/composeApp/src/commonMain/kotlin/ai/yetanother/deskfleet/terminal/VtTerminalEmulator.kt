package ai.yetanother.deskfleet.terminal

import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Packed terminal cell attributes + 24-bit / indexed / default fg & bg colors.
 */
data class TerminalCell(
    val ch: Char = ' ',
    val fg: Int = COLOR_DEFAULT_FG,
    val bg: Int = COLOR_DEFAULT_BG,
    val bold: Boolean = false,
    val dim: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
    val inverse: Boolean = false,
    val strikethrough: Boolean = false,
) {
    companion object {
        const val COLOR_DEFAULT_FG = -1
        const val COLOR_DEFAULT_BG = -2
        // Positive `0..255` = 256-color index; `(0x01000000 or (r shl 16) or (g shl 8) or b)` = 24-bit RGB
        fun rgb(r: Int, g: Int, b: Int): Int =
            0x01000000 or ((r and 0xFF) shl 16) or ((g and 0xFF) shl 8) or (b and 0xFF)

        fun isRgb(encoded: Int): Boolean = encoded >= 0x01000000
    }
}

data class TerminalSnapshot(
    val version: Long = 0L,
    val cols: Int = 120,
    val rows: Int = 34,
    val cursorCol: Int = 0,
    val cursorRow: Int = 0,
    val cursorVisible: Boolean = true,
    val altScreen: Boolean = false,
    val appCursorKeys: Boolean = false,
    val bracketedPaste: Boolean = false,
    val windowTitle: String = "",
    val oscProgressPercent: Int? = null,
    val pendingOscClipboard: String? = null,
    val scrollbackLines: List<List<TerminalCell>> = emptyList(),
    val screenLines: List<List<TerminalCell>> = emptyList(),
)

/**
 * Full VT100/ANSI/xterm terminal state machine supporting:
 * - Streaming UTF-8 decoding across arbitrary PTY chunk boundaries
 * - Primary + Alternate screen buffers (`?1049h`/`l`, `?47h`/`l`) + 5,000-line scrollback
 * - 16 ANSI, 256-color (`38;5;n`), and 24-bit TrueColor (`38;2;r;g;b`) SGR attributes
 * - DECSTBM scroll regions (`CSI top;bottom r`), DECCKM (`?1h`), bracketed paste (`?2004h`)
 * - OSC 0/2 title, OSC 9;4 progress bar, OSC 52 clipboard request
 * - Search, plain-text selection, `.ans` raw history export, and `.html` export.
 */
class VtTerminalEmulator(
    initialCols: Int = 120,
    initialRows: Int = 34,
    private val maxScrollback: Int = 5_000,
) {
    private enum class ParseState { GROUND, ESC, CSI, OSC, CHARSET }

    private var cols = initialCols.coerceIn(10, 500)
    private var rows = initialRows.coerceIn(4, 200)

    private var primaryGrid = makeGrid(rows, cols)
    private var altGrid = makeGrid(rows, cols)
    private val scrollback = ArrayDeque<Array<TerminalCell>>()
    private val rawChunks = ArrayDeque<ByteArray>()
    private var rawBytesRetained = 0

    private var useAlt = false
    private var curRow = 0
    private var curCol = 0
    private var savedRow = 0
    private var savedCol = 0
    private var scrollTop = 0
    private var scrollBottom = rows - 1

    private var curFg = TerminalCell.COLOR_DEFAULT_FG
    private var curBg = TerminalCell.COLOR_DEFAULT_BG
    private var bold = false
    private var dim = false
    private var italic = false
    private var underline = false
    private var inverse = false
    private var strike = false

    private var cursorVisible = true
    private var appCursorKeys = false
    private var bracketedPaste = false
    private var windowTitle = ""
    private var oscProgress: Int? = null
    private var pendingClipboard: String? = null

    private var state = ParseState.GROUND
    private val csiBuf = StringBuilder()
    private val oscBuf = StringBuilder()
    private var oscEscPending = false

    // Streaming UTF-8 state
    private var utf8Codepoint = 0
    private var utf8Remaining = 0

    private var versionCounter = 0L
    private val _snapshot = MutableStateFlow(buildSnapshot())
    val snapshot: StateFlow<TerminalSnapshot> = _snapshot.asStateFlow()

    private val activeGrid: Array<Array<TerminalCell>>
        get() = if (useAlt) altGrid else primaryGrid

    private fun makeGrid(r: Int, c: Int): Array<Array<TerminalCell>> =
        Array(r) { Array(c) { TerminalCell() } }

    private fun blankLine(): Array<TerminalCell> =
        Array(cols) { TerminalCell(fg = TerminalCell.COLOR_DEFAULT_FG, bg = TerminalCell.COLOR_DEFAULT_BG) }

    fun reset() {
        primaryGrid = makeGrid(rows, cols)
        altGrid = makeGrid(rows, cols)
        scrollback.clear()
        rawChunks.clear()
        rawBytesRetained = 0
        useAlt = false
        curRow = 0
        curCol = 0
        scrollTop = 0
        scrollBottom = rows - 1
        resetAttributes()
        state = ParseState.GROUND
        utf8Remaining = 0
        publish()
    }

    fun resize(newCols: Int, newRows: Int) {
        val c = newCols.coerceIn(10, 500)
        val r = newRows.coerceIn(4, 200)
        if (c == cols && r == rows) return
        primaryGrid = resizeGrid(primaryGrid, r, c)
        altGrid = resizeGrid(altGrid, r, c)
        cols = c
        rows = r
        curRow = curRow.coerceIn(0, rows - 1)
        curCol = curCol.coerceIn(0, cols - 1)
        scrollTop = 0
        scrollBottom = rows - 1
        publish()
    }

    private fun resizeGrid(old: Array<Array<TerminalCell>>, newR: Int, newC: Int): Array<Array<TerminalCell>> =
        Array(newR) { r ->
            Array(newC) { c ->
                if (r < old.size && c < old[r].size) old[r][c] else TerminalCell()
            }
        }

    fun feedBytes(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        rawChunks.addLast(bytes)
        rawBytesRetained += bytes.size
        while (rawBytesRetained > 512 * 1024 && rawChunks.size > 1) {
            rawBytesRetained -= rawChunks.removeFirst().size
        }
        for (b in bytes) {
            val u = b.toInt() and 0xFF
            if (utf8Remaining > 0) {
                if ((u and 0xC0) == 0x80) {
                    utf8Codepoint = (utf8Codepoint shl 6) or (u and 0x3F)
                    utf8Remaining -= 1
                    if (utf8Remaining == 0) {
                        val str = codePointToChars(utf8Codepoint)
                        for (ch in str) feedChar(ch)
                    }
                    continue
                } else {
                    utf8Remaining = 0
                }
            }
            when {
                u < 0x80 -> feedChar(u.toChar())
                (u and 0xE0) == 0xC0 -> {
                    utf8Codepoint = u and 0x1F
                    utf8Remaining = 1
                }
                (u and 0xF0) == 0xE0 -> {
                    utf8Codepoint = u and 0x0F
                    utf8Remaining = 2
                }
                (u and 0xF8) == 0xF0 -> {
                    utf8Codepoint = u and 0x07
                    utf8Remaining = 3
                }
                else -> feedChar('\uFFFD')
            }
        }
        publish()
    }

    private fun codePointToChars(cp: Int): String =
        if (cp <= 0xFFFF) cp.toChar().toString()
        else {
            val offset = cp - 0x10000
            val high = ((offset ushr 10) + 0xD800).toChar()
            val low = ((offset and 0x3FF) + 0xDC00).toChar()
            "$high$low"
        }

    private fun feedChar(ch: Char) {
        when (state) {
            ParseState.GROUND -> when (ch) {
                '\u001B' -> state = ParseState.ESC
                '\r' -> curCol = 0
                '\n', '\u000B', '\u000C' -> lineFeed()
                '\b' -> if (curCol > 0) curCol -= 1
                '\t' -> curCol = ((curCol / 8) + 1).let { (it * 8).coerceAtMost(cols - 1) }
                '\u0007' -> Unit // BEL
                else -> if (ch >= ' ') putGraphicChar(ch)
            }
            ParseState.ESC -> when (ch) {
                '[' -> {
                    csiBuf.clear()
                    state = ParseState.CSI
                }
                ']' -> {
                    oscBuf.clear()
                    oscEscPending = false
                    state = ParseState.OSC
                }
                '(', ')', '*', '+' -> state = ParseState.CHARSET
                '7' -> {
                    savedRow = curRow
                    savedCol = curCol
                    state = ParseState.GROUND
                }
                '8' -> {
                    curRow = savedRow.coerceIn(0, rows - 1)
                    curCol = savedCol.coerceIn(0, cols - 1)
                    state = ParseState.GROUND
                }
                'D' -> {
                    lineFeed()
                    state = ParseState.GROUND
                }
                'E' -> {
                    curCol = 0
                    lineFeed()
                    state = ParseState.GROUND
                }
                'M' -> {
                    reverseIndex()
                    state = ParseState.GROUND
                }
                'c' -> {
                    reset()
                    state = ParseState.GROUND
                }
                else -> state = ParseState.GROUND
            }
            ParseState.CHARSET -> {
                state = ParseState.GROUND
            }
            ParseState.OSC -> {
                if (oscEscPending) {
                    oscEscPending = false
                    if (ch == '\\') {
                        handleOsc(oscBuf.toString())
                        state = ParseState.GROUND
                    } else {
                        oscBuf.append('\u001B').append(ch)
                    }
                } else if (ch == '\u0007') {
                    handleOsc(oscBuf.toString())
                    state = ParseState.GROUND
                } else if (ch == '\u001B') {
                    oscEscPending = true
                } else if (oscBuf.length < 16_384) {
                    oscBuf.append(ch)
                }
            }
            ParseState.CSI -> {
                if (ch.code in 0x40..0x7E) {
                    handleCsi(csiBuf.toString(), ch)
                    state = ParseState.GROUND
                } else if (csiBuf.length < 256) {
                    csiBuf.append(ch)
                } else {
                    state = ParseState.GROUND
                }
            }
        }
    }

    private fun putGraphicChar(ch: Char) {
        if (curCol >= cols) {
            curCol = 0
            lineFeed()
        }
        activeGrid[curRow][curCol] = TerminalCell(
            ch = ch,
            fg = curFg,
            bg = curBg,
            bold = bold,
            dim = dim,
            italic = italic,
            underline = underline,
            inverse = inverse,
            strikethrough = strike,
        )
        curCol += 1
    }

    private fun lineFeed() {
        if (curRow == scrollBottom) {
            scrollUpRegion(scrollTop, scrollBottom, 1)
        } else if (curRow < rows - 1) {
            curRow += 1
        }
    }

    private fun reverseIndex() {
        if (curRow == scrollTop) {
            scrollDownRegion(scrollTop, scrollBottom, 1)
        } else if (curRow > 0) {
            curRow -= 1
        }
    }

    private fun scrollUpRegion(top: Int, bottom: Int, count: Int) {
        val grid = activeGrid
        repeat(count.coerceAtLeast(1)) {
            if (!useAlt && top == 0) {
                scrollback.addLast(grid[0].copyOf())
                while (scrollback.size > maxScrollback) scrollback.removeFirst()
            }
            for (r in top until bottom) {
                grid[r] = grid[r + 1]
            }
            grid[bottom] = blankLine()
        }
    }

    private fun scrollDownRegion(top: Int, bottom: Int, count: Int) {
        val grid = activeGrid
        repeat(count.coerceAtLeast(1)) {
            for (r in bottom downTo top + 1) {
                grid[r] = grid[r - 1]
            }
            grid[top] = blankLine()
        }
    }

    private fun handleCsi(rawParams: String, finalChar: Char) {
        val privateMode = rawParams.startsWith("?")
        val clean = if (privateMode) rawParams.drop(1) else rawParams.trimStart('>', '!')
        val nums = if (clean.isEmpty()) emptyList() else clean.split(';').map { it.toIntOrNull() ?: 0 }
        fun p(idx: Int, def: Int = 1): Int = nums.getOrNull(idx)?.takeIf { it > 0 } ?: def

        if (privateMode) {
            val enable = finalChar == 'h'
            if (finalChar == 'h' || finalChar == 'l') {
                for (code in nums) {
                    when (code) {
                        1 -> appCursorKeys = enable
                        25 -> cursorVisible = enable
                        47, 1047, 1049 -> {
                            if (enable && !useAlt) {
                                savedRow = curRow
                                savedCol = curCol
                                altGrid = makeGrid(rows, cols)
                                useAlt = true
                                curRow = 0
                                curCol = 0
                            } else if (!enable && useAlt) {
                                useAlt = false
                                curRow = savedRow.coerceIn(0, rows - 1)
                                curCol = savedCol.coerceIn(0, cols - 1)
                            }
                        }
                        2004 -> bracketedPaste = enable
                    }
                }
            }
            return
        }

        val grid = activeGrid
        when (finalChar) {
            'A' -> curRow = (curRow - p(0)).coerceAtLeast(0)
            'B' -> curRow = (curRow + p(0)).coerceAtMost(rows - 1)
            'C' -> curCol = (curCol + p(0)).coerceAtMost(cols - 1)
            'D' -> curCol = (curCol - p(0)).coerceAtLeast(0)
            'E' -> {
                curRow = (curRow + p(0)).coerceAtMost(rows - 1)
                curCol = 0
            }
            'F' -> {
                curRow = (curRow - p(0)).coerceAtLeast(0)
                curCol = 0
            }
            'G', '`' -> curCol = (p(0) - 1).coerceIn(0, cols - 1)
            'd' -> curRow = (p(0) - 1).coerceIn(0, rows - 1)
            'H', 'f' -> {
                curRow = (p(0) - 1).coerceIn(0, rows - 1)
                curCol = (p(1) - 1).coerceIn(0, cols - 1)
            }
            'J' -> {
                val mode = nums.firstOrNull() ?: 0
                when (mode) {
                    0 -> {
                        for (c in curCol until cols) grid[curRow][c] = blankCell()
                        for (r in (curRow + 1) until rows) grid[r] = blankLine()
                    }
                    1 -> {
                        for (r in 0 until curRow) grid[r] = blankLine()
                        for (c in 0..curCol.coerceAtMost(cols - 1)) grid[curRow][c] = blankCell()
                    }
                    2, 3 -> {
                        for (r in 0 until rows) grid[r] = blankLine()
                        if (mode == 3) scrollback.clear()
                    }
                }
            }
            'K' -> {
                val mode = nums.firstOrNull() ?: 0
                when (mode) {
                    0 -> for (c in curCol.coerceAtMost(cols - 1) until cols) grid[curRow][c] = blankCell()
                    1 -> for (c in 0..curCol.coerceAtMost(cols - 1)) grid[curRow][c] = blankCell()
                    2 -> grid[curRow] = blankLine()
                }
            }
            'L' -> scrollDownRegion(curRow, scrollBottom, p(0))
            'M' -> scrollUpRegion(curRow, scrollBottom, p(0))
            'P' -> {
                val n = p(0)
                val row = grid[curRow]
                for (c in curCol until cols) {
                    row[c] = if (c + n < cols) row[c + n] else blankCell()
                }
            }
            '@' -> {
                val n = p(0)
                val row = grid[curRow]
                for (c in (cols - 1) downTo curCol) {
                    row[c] = if (c - n >= curCol) row[c - n] else blankCell()
                }
            }
            'X' -> {
                val n = p(0)
                for (c in curCol until minOf(cols, curCol + n)) {
                    grid[curRow][c] = blankCell()
                }
            }
            'S' -> scrollUpRegion(scrollTop, scrollBottom, p(0))
            'T' -> scrollDownRegion(scrollTop, scrollBottom, p(0))
            'r' -> {
                val top = (p(0, 1) - 1).coerceIn(0, rows - 1)
                val bot = (p(1, rows) - 1).coerceIn(0, rows - 1)
                if (top < bot) {
                    scrollTop = top
                    scrollBottom = bot
                    curRow = 0
                    curCol = 0
                }
            }
            's' -> {
                savedRow = curRow
                savedCol = curCol
            }
            'u' -> {
                curRow = savedRow.coerceIn(0, rows - 1)
                curCol = savedCol.coerceIn(0, cols - 1)
            }
            'm' -> handleSgr(if (nums.isEmpty()) listOf(0) else nums)
        }
    }

    private fun blankCell(): TerminalCell =
        TerminalCell(fg = TerminalCell.COLOR_DEFAULT_FG, bg = curBg)

    private fun resetAttributes() {
        curFg = TerminalCell.COLOR_DEFAULT_FG
        curBg = TerminalCell.COLOR_DEFAULT_BG
        bold = false
        dim = false
        italic = false
        underline = false
        inverse = false
        strike = false
    }

    private fun handleSgr(codes: List<Int>) {
        var i = 0
        while (i < codes.size) {
            when (val c = codes[i]) {
                0 -> resetAttributes()
                1 -> bold = true
                2 -> dim = true
                3 -> italic = true
                4 -> underline = true
                7 -> inverse = true
                9 -> strike = true
                21, 22 -> {
                    bold = false
                    dim = false
                }
                23 -> italic = false
                24 -> underline = false
                27 -> inverse = false
                29 -> strike = false
                in 30..37 -> curFg = c - 30
                39 -> curFg = TerminalCell.COLOR_DEFAULT_FG
                in 40..47 -> curBg = c - 40
                49 -> curBg = TerminalCell.COLOR_DEFAULT_BG
                in 90..97 -> curFg = (c - 90) + 8
                in 100..107 -> curBg = (c - 100) + 8
                38, 48 -> {
                    val isFg = c == 38
                    val mode = codes.getOrNull(i + 1) ?: 0
                    if (mode == 5 && i + 2 < codes.size) {
                        val idx = codes[i + 2].coerceIn(0, 255)
                        if (isFg) curFg = idx else curBg = idx
                        i += 2
                    } else if (mode == 2 && i + 4 < codes.size) {
                        val encoded = TerminalCell.rgb(codes[i + 2], codes[i + 3], codes[i + 4])
                        if (isFg) curFg = encoded else curBg = encoded
                        i += 4
                    }
                }
            }
            i += 1
        }
    }

    @OptIn(ExperimentalEncodingApi::class)
    private fun handleOsc(osc: String) {
        val semi = osc.indexOf(';')
        if (semi < 0) return
        val cmd = osc.substring(0, semi)
        val arg = osc.substring(semi + 1)
        when (cmd) {
            "0", "2" -> windowTitle = arg.take(256)
            "9" -> {
                // ConEmu / DeskFleet OSC 9;4;state;progress
                val parts = arg.split(';')
                if (parts.firstOrNull() == "4") {
                    val st = parts.getOrNull(1)?.toIntOrNull() ?: 0
                    val pct = parts.getOrNull(2)?.toIntOrNull()
                    oscProgress = if (st == 0) null else pct?.coerceIn(0, 100)
                }
            }
            "52" -> {
                val b64 = arg.substringAfter(';', "")
                if (b64.isNotEmpty() && b64 != "?") {
                    runCatching { Base64.decode(b64).decodeToString() }.getOrNull()?.let {
                        pendingClipboard = it
                    }
                }
            }
        }
    }

    fun consumePendingOscClipboard(): String? {
        val v = pendingClipboard
        pendingClipboard = null
        if (v != null) publish()
        return v
    }

    fun encodeSpecialKey(keyName: String): String = when (keyName) {
        "ArrowUp" -> if (appCursorKeys) "\u001BOA" else "\u001B[A"
        "ArrowDown" -> if (appCursorKeys) "\u001BOB" else "\u001B[B"
        "ArrowRight" -> if (appCursorKeys) "\u001BOC" else "\u001B[C"
        "ArrowLeft" -> if (appCursorKeys) "\u001BOD" else "\u001B[D"
        "Home" -> if (appCursorKeys) "\u001BOH" else "\u001B[H"
        "End" -> if (appCursorKeys) "\u001BOF" else "\u001B[F"
        "PageUp" -> "\u001B[5~"
        "PageDown" -> "\u001B[6~"
        "Delete" -> "\u001B[3~"
        "Insert" -> "\u001B[2~"
        "Backspace" -> "\u007F"
        "Tab" -> "\t"
        "Enter" -> "\r"
        "Escape" -> "\u001B"
        "F1" -> "\u001BOP"
        "F2" -> "\u001BOQ"
        "F3" -> "\u001BOR"
        "F4" -> "\u001BOS"
        "F5" -> "\u001B[15~"
        "F6" -> "\u001B[17~"
        "F7" -> "\u001B[18~"
        "F8" -> "\u001B[19~"
        "F9" -> "\u001B[20~"
        "F10" -> "\u001B[21~"
        "F11" -> "\u001B[23~"
        "F12" -> "\u001B[24~"
        else -> ""
    }

    fun formatPaste(text: String): String =
        if (bracketedPaste) "\u001B[200~$text\u001B[201~" else text

    fun exportPlainText(): String = buildString {
        val snap = _snapshot.value
        for (line in snap.scrollbackLines + snap.screenLines) {
            append(line.map { it.ch }.joinToString("").trimEnd())
            append('\n')
        }
    }

    fun exportAnsiBytes(): ByteArray {
        val out = ByteArray(rawBytesRetained)
        var pos = 0
        for (c in rawChunks) {
            c.copyInto(out, destinationOffset = pos)
            pos += c.size
        }
        return out
    }

    fun exportHtml(): String = buildString {
        append("<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>")
        append(windowTitle.ifBlank { "DeskFleet Terminal" })
        append("</title><style>body{background:#15171d;color:#e7e9ef;font-family:ui-monospace,monospace;font-size:13px;padding:16px;}pre{margin:0;line-height:1.4;}</style></head><body><pre>")
        for (ch in exportPlainText()) {
            when (ch) {
                '<' -> append("&lt;")
                '>' -> append("&gt;")
                '&' -> append("&amp;")
                else -> append(ch)
            }
        }
        append("</pre></body></html>")
    }

    fun findMatches(query: String, ignoreCase: Boolean = true): List<Pair<Int, Int>> {
        if (query.isEmpty()) return emptyList()
        val snap = _snapshot.value
        val all = snap.scrollbackLines + snap.screenLines
        val hits = mutableListOf<Pair<Int, Int>>()
        all.forEachIndexed { rowIdx, cells ->
            val lineStr = cells.map { it.ch }.joinToString("")
            var idx = lineStr.indexOf(query, 0, ignoreCase)
            while (idx >= 0) {
                hits.add(rowIdx to idx)
                idx = lineStr.indexOf(query, idx + 1, ignoreCase)
            }
        }
        return hits
    }

    private fun publish() {
        versionCounter += 1L
        _snapshot.value = buildSnapshot()
    }

    private fun buildSnapshot(): TerminalSnapshot = TerminalSnapshot(
        version = versionCounter,
        cols = cols,
        rows = rows,
        cursorCol = curCol,
        cursorRow = curRow,
        cursorVisible = cursorVisible,
        altScreen = useAlt,
        appCursorKeys = appCursorKeys,
        bracketedPaste = bracketedPaste,
        windowTitle = windowTitle,
        oscProgressPercent = oscProgress,
        pendingOscClipboard = pendingClipboard,
        scrollbackLines = if (useAlt) emptyList() else scrollback.map { it.toList() },
        screenLines = activeGrid.map { it.toList() },
    )
}
