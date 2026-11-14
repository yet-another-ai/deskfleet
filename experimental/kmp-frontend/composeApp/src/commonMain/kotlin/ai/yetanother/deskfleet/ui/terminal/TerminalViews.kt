package ai.yetanother.deskfleet.ui.terminal

import ai.yetanother.deskfleet.protocol.MachineScope
import ai.yetanother.deskfleet.protocol.TerminalSummary
import ai.yetanother.deskfleet.state.AppController
import ai.yetanother.deskfleet.state.PaneTab
import ai.yetanother.deskfleet.state.StickyModifierState
import ai.yetanother.deskfleet.state.TerminalLiveSession
import ai.yetanother.deskfleet.terminal.TerminalCell
import ai.yetanother.deskfleet.ui.common.*
import ai.yetanother.deskfleet.ui.theme.LocalDeskFleetColors
import ai.yetanother.deskfleet.ui.theme.TERMINAL_THEMES
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.*
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/**
 * Interactive Remote PTY Terminal View (`TerminalWorkspace.vue` + `TerminalSurface.vue` + `TerminalKeypad.vue`).
 */
@Composable
fun TerminalWorkspaceView(
    controller: AppController,
    machineScope: MachineScope,
    terminalId: String,
    isMobileLayout: Boolean,
) {
    val palette = LocalDeskFleetColors.current
    val prefs by controller.preferences.collectAsState()
    val runtime = remember(machineScope) { controller.runtimeFor(machineScope) }
    val catalog by runtime.catalog.collectAsState()
    val scope = rememberCoroutineScope()

    var liveSession by remember(machineScope, terminalId) {
        mutableStateOf(runtime.getTerminalSession(terminalId))
    }
    var connectError by remember { mutableStateOf<String?>(null) }
    var searchOpen by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }
    var directInputLine by remember { mutableStateOf("") }

    val termTheme = remember(prefs.terminalPreset) {
        TERMINAL_THEMES.firstOrNull { it.id == prefs.terminalPreset } ?: TERMINAL_THEMES.first()
    }

    LaunchedEffect(machineScope, terminalId) {
        if (liveSession == null) {
            val summary = catalog.terminals.firstOrNull { it.id == terminalId }
                ?: TerminalSummary(id = terminalId, title = "Terminal")
            runCatching {
                liveSession = runtime.attachTerminalSession(summary)
            }.onFailure { connectError = it.message }
        } else {
            runCatching { liveSession?.connectAndAttach() }
                .onFailure { connectError = it.message }
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(termTheme.background)) {
        // Terminal Toolbar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(palette.surface)
                .padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val snap = liveSession?.snapshot?.collectAsState()?.value
            val summary = liveSession?.summary?.collectAsState()?.value
            StatusDot(online = liveSession?.ready?.collectAsState()?.value == true)
            Text(
                text = snap?.windowTitle?.ifBlank { summary?.title } ?: "Terminal",
                color = palette.text,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            UiButton(
                text = "⌕",
                size = ButtonSize.SM,
                active = searchOpen,
                onClick = { searchOpen = !searchOpen },
            )
            UiButton(
                text = "Paste",
                size = ButtonSize.SM,
                onClick = {
                    controller.hostBridge.readFromClipboard()?.let { clip ->
                        liveSession?.pasteText(clip)
                    }
                },
            )
            UiButton(
                text = "Export .ans",
                size = ButtonSize.SM,
                onClick = {
                    liveSession?.emulator?.exportAnsiBytes()?.decodeToString()?.let {
                        controller.hostBridge.copyToClipboard(it)
                    }
                },
            )
            UiButton(
                text = "Export .html",
                size = ButtonSize.SM,
                onClick = {
                    liveSession?.emulator?.exportHtml()?.let {
                        controller.hostBridge.copyToClipboard(it)
                    }
                },
            )
            UiButton(
                text = "+ Shell",
                size = ButtonSize.SM,
                onClick = {
                    scope.launch {
                        runCatching {
                            val created = runtime.dialNewTerminal()
                            controller.openTab(PaneTab.Terminal(machineScope, created.terminalId, created.summary.value.title))
                        }
                    }
                },
            )
            UiButton(
                text = "Hangup",
                size = ButtonSize.SM,
                variant = ButtonVariant.DANGER,
                onClick = {
                    scope.launch {
                        runtime.hangupTerminal(terminalId)
                        controller.closeTab("terminal:${machineScope.key}:$terminalId")
                    }
                },
            )
        }

        val activeSession = liveSession
        if (connectError != null) {
            Box(Modifier.padding(12.dp)) { ErrorNotice(message = connectError!!) }
        }

        if (activeSession != null) {
            val snap by activeSession.snapshot.collectAsState()

            // OSC 9;4 Progress Bar
            snap.oscProgressPercent?.let { pct ->
                LinearProgressIndicator(
                    progress = { (pct / 100f).coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth().height(3.dp),
                    color = palette.accent,
                    trackColor = palette.border,
                )
            }

            // OSC 52 Remote Clipboard Request Banner
            snap.pendingOscClipboard?.let { oscClip ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(palette.accentSoft)
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        "Remote process requested to copy ${oscClip.length} characters to clipboard",
                        color = palette.text,
                        fontSize = 12.sp,
                        modifier = Modifier.weight(1f),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        UiButton(
                            text = "Allow",
                            size = ButtonSize.SM,
                            variant = ButtonVariant.PRIMARY,
                            onClick = {
                                controller.hostBridge.copyToClipboard(oscClip)
                                activeSession.emulator.consumePendingOscClipboard()
                            },
                        )
                        UiButton(
                            text = "Dismiss",
                            size = ButtonSize.SM,
                            onClick = { activeSession.emulator.consumePendingOscClipboard() },
                        )
                    }
                }
            }

            // Search Bar (`TerminalSearch.vue`)
            SpringCollapse(visible = searchOpen) {
                val hits = remember(snap.version, searchQuery) {
                    activeSession.emulator.findMatches(searchQuery)
                }
                Row(
                    modifier = Modifier.fillMaxWidth().background(palette.surface).padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    UiField(
                        value = searchQuery,
                        onValueChange = { searchQuery = it },
                        placeholder = "Find in terminal buffer…",
                        monospace = true,
                        modifier = Modifier.weight(1f),
                    )
                    Text("${hits.size} matches", color = palette.textMuted, fontSize = 12.sp)
                }
            }

            // VT100/ANSI/TrueColor Surface (`TerminalSurface.vue`)
            TerminalGridSurface(
                session = activeSession,
                theme = termTheme,
                fontSizeSp = prefs.terminalFontSizeSp,
                searchHighlight = searchQuery,
                modifier = Modifier.weight(1f).fillMaxWidth(),
            )

            // Mobile / Soft-Keyboard Line Input + Sticky Keypad (`<1024dp`)
            if (isMobileLayout) {
                Row(
                    modifier = Modifier.fillMaxWidth().background(palette.surface).padding(horizontal = 8.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    UiField(
                        value = directInputLine,
                        onValueChange = { directInputLine = it },
                        placeholder = "Type command…",
                        monospace = true,
                        modifier = Modifier.weight(1f),
                    )
                    UiButton(
                        text = "⏎",
                        size = ButtonSize.SM,
                        variant = ButtonVariant.PRIMARY,
                        onClick = {
                            activeSession.sendUserText(directInputLine + "\r")
                            directInputLine = ""
                        },
                    )
                }
                TerminalKeypadBar(session = activeSession)
            }
        }
    }
}

@Composable
private fun TerminalGridSurface(
    session: TerminalLiveSession,
    theme: ai.yetanother.deskfleet.ui.theme.TerminalColorTheme,
    fontSizeSp: Float,
    searchHighlight: String,
    modifier: Modifier = Modifier,
) {
    val snap by session.snapshot.collectAsState()
    val focusRequester = remember { FocusRequester() }
    val scrollState = rememberScrollState()
    val density = LocalDensity.current

    LaunchedEffect(Unit) {
        runCatching { focusRequester.requestFocus() }
    }
    LaunchedEffect(snap.version) {
        if (!snap.altScreen) {
            scrollState.scrollTo(scrollState.maxValue)
        }
    }

    Box(
        modifier = modifier
            .background(theme.background)
            .focusRequester(focusRequester)
            .focusable()
            .clickable { runCatching { focusRequester.requestFocus() } }
            .onSizeChanged { sz ->
                with(density) {
                    val approxCharWidthPx = (fontSizeSp * 0.62f).sp.toPx().coerceAtLeast(6f)
                    val approxLineHeightPx = (fontSizeSp * 1.35f).sp.toPx().coerceAtLeast(12f)
                    val cols = ((sz.width - 20f) / approxCharWidthPx).toInt().coerceIn(24, 320)
                    val rows = ((sz.height - 16f) / approxLineHeightPx).toInt().coerceIn(8, 120)
                    session.resize(cols, rows)
                }
            }
            .onPreviewKeyEvent { ev ->
                if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val appCursor = snap.appCursorKeys
                val mapped: String? = when (ev.key) {
                    Key.Enter, Key.NumPadEnter -> "\r"
                    Key.Backspace -> "\u007f"
                    Key.Tab -> "\t"
                    Key.Escape -> "\u001b"
                    Key.DirectionUp -> if (appCursor) "\u001bOA" else "\u001b[A"
                    Key.DirectionDown -> if (appCursor) "\u001bOB" else "\u001b[B"
                    Key.DirectionRight -> if (appCursor) "\u001bOC" else "\u001b[C"
                    Key.DirectionLeft -> if (appCursor) "\u001bOD" else "\u001b[D"
                    Key.MoveHome -> "\u001b[H"
                    Key.MoveEnd -> "\u001b[F"
                    Key.PageUp -> "\u001b[5~"
                    Key.PageDown -> "\u001b[6~"
                    Key.Delete -> "\u001b[3~"
                    else -> {
                        val cp = ev.utf16CodePoint
                        if (ev.isCtrlPressed && cp in 97..122) {
                            ((cp - 96).toChar()).toString()
                        } else if (cp >= 32) {
                            cp.toChar().toString()
                        } else null
                    }
                }
                if (mapped != null) {
                    session.sendUserText(mapped)
                    true
                } else {
                    false
                }
            }
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        val allLines = remember(snap.version) {
            if (snap.altScreen) snap.screenLines else (snap.scrollbackLines + snap.screenLines)
        }
        val screenStartIdx = if (snap.altScreen) 0 else snap.scrollbackLines.size

        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(scrollState),
        ) {
            allLines.forEachIndexed { lineIdx, cells ->
                val cursorCol = if (snap.cursorVisible && lineIdx == screenStartIdx + snap.cursorRow) {
                    snap.cursorCol
                } else -1
                val annotated = remember(cells, cursorCol, theme, searchHighlight) {
                    buildStyledTerminalLine(cells, cursorCol, theme)
                }
                Text(
                    text = annotated,
                    fontFamily = FontFamily.Monospace,
                    fontSize = fontSizeSp.sp,
                    lineHeight = (fontSizeSp * 1.32f).sp,
                    softWrap = false,
                )
            }
        }
    }
}

private fun buildStyledTerminalLine(
    cells: List<TerminalCell>,
    cursorCol: Int,
    theme: ai.yetanother.deskfleet.ui.theme.TerminalColorTheme,
): AnnotatedString = buildAnnotatedString {
    var lastNonSpace = cells.indexOfLast { it.ch != ' ' || it.bg != TerminalCell.COLOR_DEFAULT_BG }
    if (cursorCol > lastNonSpace) lastNonSpace = cursorCol
    if (lastNonSpace < 0) return@buildAnnotatedString

    for (col in 0..minOf(cells.lastIndex, lastNonSpace)) {
        val c = cells[col]
        val isCursor = col == cursorCol
        val rawFg = theme.resolveCellColor(c.fg, isForeground = true)
        val rawBg = theme.resolveCellColor(c.bg, isForeground = false)
        val fg = when {
            isCursor -> theme.background
            c.inverse -> rawBg
            c.dim -> rawFg.copy(alpha = 0.65f)
            else -> rawFg
        }
        val bg = when {
            isCursor -> theme.cursor
            c.inverse -> rawFg
            c.bg == TerminalCell.COLOR_DEFAULT_BG -> androidx.compose.ui.graphics.Color.Transparent
            else -> rawBg
        }
        pushStyle(
            SpanStyle(
                color = fg,
                background = bg,
                fontWeight = if (c.bold) FontWeight.Bold else FontWeight.Normal,
                fontStyle = if (c.italic) FontStyle.Italic else FontStyle.Normal,
                textDecoration = when {
                    c.underline && c.strikethrough -> TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough))
                    c.underline -> TextDecoration.Underline
                    c.strikethrough -> TextDecoration.LineThrough
                    else -> TextDecoration.None
                },
            )
        )
        append(c.ch)
        pop()
    }
}

/**
 * Mobile `<1024dp` Terminal Keypad (`TerminalKeypad.vue`) with 3-state sticky `Ctrl`/`Alt`
 * and expandable `Home..PgDn` + `F1..F12` drawer!
 */
@Composable
fun TerminalKeypadBar(session: TerminalLiveSession) {
    val palette = LocalDeskFleetColors.current
    val ctrl by session.ctrlState.collectAsState()
    val alt by session.altState.collectAsState()
    val snap by session.snapshot.collectAsState()
    var expandedMore by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.sidebar)
            .border(1.dp, palette.border)
            .padding(horizontal = 6.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            KeypadKey("Esc") { session.sendUserText("\u001b") }
            KeypadKey("Tab") { session.sendUserText("\t") }
            KeypadKey(
                label = when (ctrl) {
                    StickyModifierState.OFF -> "Ctrl"
                    StickyModifierState.ONCE -> "Ctrl•"
                    StickyModifierState.LOCKED -> "Ctrl🔒"
                },
                active = ctrl != StickyModifierState.OFF,
                onClick = { session.toggleCtrl() },
            )
            KeypadKey(
                label = when (alt) {
                    StickyModifierState.OFF -> "Alt"
                    StickyModifierState.ONCE -> "Alt•"
                    StickyModifierState.LOCKED -> "Alt🔒"
                },
                active = alt != StickyModifierState.OFF,
                onClick = { session.toggleAlt() },
            )
            KeypadKey("←") { session.sendUserText(if (snap.appCursorKeys) "\u001bOD" else "\u001b[D") }
            KeypadKey("↓") { session.sendUserText(if (snap.appCursorKeys) "\u001bOB" else "\u001b[B") }
            KeypadKey("↑") { session.sendUserText(if (snap.appCursorKeys) "\u001bOA" else "\u001b[A") }
            KeypadKey("→") { session.sendUserText(if (snap.appCursorKeys) "\u001bOC" else "\u001b[C") }
            KeypadKey("|") { session.sendUserText("|") }
            KeypadKey("/") { session.sendUserText("/") }
            KeypadKey("-") { session.sendUserText("-") }
            KeypadKey("Fn…", active = expandedMore) { expandedMore = !expandedMore }
        }

        SpringCollapse(visible = expandedMore) {
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                KeypadKey("Home") { session.sendUserText("\u001b[H") }
                KeypadKey("End") { session.sendUserText("\u001b[F") }
                KeypadKey("PgUp") { session.sendUserText("\u001b[5~") }
                KeypadKey("PgDn") { session.sendUserText("\u001b[6~") }
                listOf(
                    "F1" to "\u001bOP", "F2" to "\u001bOQ", "F3" to "\u001bOR", "F4" to "\u001bOS",
                    "F5" to "\u001b[15~", "F6" to "\u001b[17~", "F7" to "\u001b[18~", "F8" to "\u001b[19~",
                    "F9" to "\u001b[20~", "F10" to "\u001b[21~", "F11" to "\u001b[23~", "F12" to "\u001b[24~",
                ).forEach { (lbl, seq) ->
                    KeypadKey(lbl) { session.sendUserText(seq) }
                }
            }
        }
    }
}

@Composable
private fun KeypadKey(
    label: String,
    active: Boolean = false,
    onClick: () -> Unit,
) {
    val palette = LocalDeskFleetColors.current
    val shape = RoundedCornerShape(6.dp)
    Box(
        modifier = Modifier
            .height(30.dp)
            .defaultMinSize(minWidth = 36.dp)
            .clip(shape)
            .background(if (active) palette.action else palette.control)
            .border(1.dp, if (active) palette.action else palette.border, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = if (active) palette.actionText else palette.text,
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Medium,
        )
    }
}
