package ai.yetanother.deskfleet.ui.details

import ai.yetanother.deskfleet.protocol.GitChangedFile
import ai.yetanother.deskfleet.protocol.GitStatusSnapshot
import ai.yetanother.deskfleet.state.SessionLiveController
import ai.yetanother.deskfleet.ui.common.ButtonSize
import ai.yetanother.deskfleet.ui.common.ButtonVariant
import ai.yetanother.deskfleet.ui.common.SpringCollapse
import ai.yetanother.deskfleet.ui.common.UiButton
import ai.yetanother.deskfleet.ui.theme.LocalDeskFleetColors
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/**
 * Right-hand Git Changes Drawer (`ChangesPanel.vue`) + 3-column unified diff renderer (`GitDiffCard.vue`).
 */
@Composable
fun GitChangesDrawer(
    sessionController: SessionLiveController,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalDeskFleetColors.current
    val gitStatus by sessionController.gitStatus.collectAsState()
    val scope = rememberCoroutineScope()

    LaunchedEffect(sessionController.sessionScope.key) {
        sessionController.refreshGitStatus(force = true)
    }

    Column(
        modifier = modifier
            .width(380.dp)
            .fillMaxHeight()
            .background(palette.sidebar)
            .border(1.dp, palette.border)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column {
                Text("Working Tree Changes", color = palette.text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                if (!gitStatus.branch.isNullOrBlank()) {
                    Text(
                        text = "⎇ ${gitStatus.branch}  (↑${gitStatus.ahead} ↓${gitStatus.behind})",
                        color = palette.textMuted,
                        fontSize = 11.5.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                UiButton(
                    text = "↻",
                    size = ButtonSize.ICON,
                    variant = ButtonVariant.GHOST,
                    onClick = { scope.launch { sessionController.refreshGitStatus(force = true) } },
                )
                UiButton(
                    text = "✕",
                    size = ButtonSize.ICON,
                    variant = ButtonVariant.GHOST,
                    onClick = onClose,
                )
            }
        }

        GitChangesList(
            gitStatus = gitStatus,
            onRequestPatch = { file -> sessionController.loadFileDiff(file) },
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
fun GitChangesList(
    gitStatus: GitStatusSnapshot,
    onRequestPatch: suspend (GitChangedFile) -> String,
    modifier: Modifier = Modifier,
) {
    val palette = LocalDeskFleetColors.current
    if (gitStatus.files.isEmpty()) {
        Box(
            modifier = modifier.fillMaxWidth().padding(24.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text("Working tree is clean", color = palette.textFaint, fontSize = 13.sp)
        }
        return
    }

    Column(
        modifier = modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        gitStatus.files.forEach { file ->
            ExpandableGitFileCard(file = file, onRequestPatch = onRequestPatch)
        }
    }
}

@Composable
private fun ExpandableGitFileCard(
    file: GitChangedFile,
    onRequestPatch: suspend (GitChangedFile) -> String,
) {
    val palette = LocalDeskFleetColors.current
    var expanded by remember { mutableStateOf(false) }
    var patchText by remember(file.patch) { mutableStateOf(file.patch) }
    val scope = rememberCoroutineScope()

    val statusColor = when (file.status) {
        "added", "untracked" -> palette.success
        "deleted" -> palette.danger
        else -> palette.warning
    }
    val shape = RoundedCornerShape(9.dp)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(palette.surface)
            .border(1.dp, palette.border, shape),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable {
                    expanded = !expanded
                    if (expanded && patchText.isBlank()) {
                        scope.launch {
                            runCatching { patchText = onRequestPatch(file) }
                        }
                    }
                }
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = file.status.firstOrNull()?.uppercaseChar()?.toString() ?: "M",
                color = statusColor,
                fontSize = 11.5.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                text = file.path,
                color = palette.text,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (file.additions > 0 || file.deletions > 0) {
                Text("+${file.additions}", color = palette.success, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                Text("-${file.deletions}", color = palette.danger, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            }
            Text(if (expanded) "▾" else "▸", color = palette.textFaint, fontSize = 11.sp)
        }

        SpringCollapse(visible = expanded) {
            UnifiedDiffRenderer(patch = patchText)
        }
    }
}

/**
 * 3-column unified diff renderer (`oldLine | newLine | code`) matching `GitDiffCard.vue`.
 */
@Composable
fun UnifiedDiffRenderer(
    patch: String,
    modifier: Modifier = Modifier,
) {
    val palette = LocalDeskFleetColors.current
    if (patch.isBlank()) {
        Box(modifier = modifier.fillMaxWidth().padding(10.dp)) {
            Text("No diff hunks available", color = palette.textFaint, fontSize = 11.5.sp)
        }
        return
    }

    val lines = remember(patch) { parseUnifiedPatchLines(patch) }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(palette.canvas)
            .horizontalScroll(rememberScrollState())
            .padding(vertical = 4.dp),
    ) {
        lines.forEach { row ->
            val bg = when (row.kind) {
                '+' -> palette.successSoft
                '-' -> palette.dangerSoft
                '@' -> palette.accentSoft.copy(alpha = 0.45f)
                else -> Color.Transparent
            }
            val fg = when (row.kind) {
                '+' -> palette.success
                '-' -> palette.danger
                '@' -> palette.accent
                else -> palette.text
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(bg)
                    .padding(horizontal = 8.dp, vertical = 1.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = row.oldLine?.toString()?.padStart(4, ' ') ?: "    ",
                    color = palette.textFaint,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                )
                Text(
                    text = row.newLine?.toString()?.padStart(4, ' ') ?: "    ",
                    color = palette.textFaint,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                )
                Text(
                    text = row.content,
                    color = fg,
                    fontSize = 11.5.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}

private data class ParsedDiffLine(
    val kind: Char,
    val oldLine: Int?,
    val newLine: Int?,
    val content: String,
)

private val HUNK_REGEX = Regex("""^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*""")

private fun parseUnifiedPatchLines(patch: String): List<ParsedDiffLine> {
    val out = mutableListOf<ParsedDiffLine>()
    var oldNum = 1
    var newNum = 1
    for (raw in patch.lines()) {
        if (raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("diff ") || raw.startsWith("index ")) {
            continue
        }
        val m = HUNK_REGEX.matchEntire(raw)
        if (m != null) {
            oldNum = m.groupValues[1].toIntOrNull() ?: 1
            newNum = m.groupValues[2].toIntOrNull() ?: 1
            out.add(ParsedDiffLine('@', null, null, raw))
            continue
        }
        when {
            raw.startsWith('+') -> {
                out.add(ParsedDiffLine('+', null, newNum++, raw))
            }
            raw.startsWith('-') -> {
                out.add(ParsedDiffLine('-', oldNum++, null, raw))
            }
            else -> {
                out.add(ParsedDiffLine(' ', oldNum++, newNum++, raw))
            }
        }
    }
    return out
}
