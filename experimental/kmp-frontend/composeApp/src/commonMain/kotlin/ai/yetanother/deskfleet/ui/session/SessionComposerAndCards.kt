package ai.yetanother.deskfleet.ui.session

import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.state.*
import ai.yetanother.deskfleet.ui.common.*
import ai.yetanother.deskfleet.ui.theme.LocalDeskFleetColors
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

@Composable
internal fun PlanStepsCard(steps: List<PlanStepItem>) {
    val palette = LocalDeskFleetColors.current
    val shape = RoundedCornerShape(9.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(palette.surface)
            .border(1.dp, palette.border, shape)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text("Execution Plan", color = palette.text, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
        steps.forEach { step ->
            val icon = when (step.status) {
                "completed" -> "✓"
                "in_progress" -> "◉"
                else -> "○"
            }
            Text("$icon  ${step.content}", color = palette.textMuted, fontSize = 12.5.sp)
        }
    }
}

@Composable
internal fun PermissionApprovalBar(
    permission: PendingPermissionRequest,
    onRespond: (String) -> Unit,
) {
    val palette = LocalDeskFleetColors.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.warningSoft)
            .border(1.dp, palette.warning.copy(alpha = 0.4f))
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Permission required: ${permission.title}", color = palette.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        if (!permission.command.isNullOrBlank()) {
            Text(permission.command, color = palette.textMuted, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            permission.options.forEach { opt ->
                val v = when {
                    opt.kind.startsWith("allow") -> ButtonVariant.PRIMARY
                    opt.kind.startsWith("reject") -> ButtonVariant.DANGER
                    else -> ButtonVariant.SUBTLE
                }
                UiButton(text = opt.name, size = ButtonSize.SM, variant = v, onClick = { onRespond(opt.optionId) })
            }
        }
    }
}

@Composable
internal fun ElicitationBar(
    elicitation: PendingElicitationRequest,
    onRespond: (String, Map<String, String>) -> Unit,
) {
    val palette = LocalDeskFleetColors.current
    var answer by remember { mutableStateOf("") }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.surfaceElevated)
            .border(1.dp, palette.accent.copy(alpha = 0.4f))
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(elicitation.message, color = palette.text, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        UiField(value = answer, onValueChange = { answer = it }, placeholder = "Enter response…")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            UiButton(text = "Submit", size = ButtonSize.SM, variant = ButtonVariant.PRIMARY, onClick = { onRespond("accept", mapOf("value" to answer)) })
            UiButton(text = "Decline", size = ButtonSize.SM, variant = ButtonVariant.GHOST, onClick = { onRespond("decline", emptyMap()) })
        }
    }
}

@Composable
internal fun SessionComposerBar(
    live: SessionLiveController,
    isStreaming: Boolean,
    usage: SessionUsageSummary?,
    backlog: List<QueuedPromptItem>,
    completions: List<ComposerCompletionItem>,
    yoloEnabled: Boolean,
    suppressCostOnMobile: Boolean,
) {
    val palette = LocalDeskFleetColors.current
    var draft by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.surface)
            .border(1.dp, palette.border)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        backlog.forEach { q ->
            Row(
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).background(palette.control).padding(6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("Queued: ${q.text}", color = palette.textMuted, fontSize = 12.sp, maxLines = 1, modifier = Modifier.weight(1f))
                UiButton(text = "Withdraw", size = ButtonSize.SM, variant = ButtonVariant.GHOST, onClick = {
                    scope.launch { live.withdrawBacklogItem(q.inputId) }
                })
            }
        }

        if (completions.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                completions.take(8).forEach { c ->
                    UiButton(
                        text = "${c.trigger}${c.label}",
                        size = ButtonSize.SM,
                        onClick = {
                            draft = draft.substringBeforeLast(c.trigger) + c.insertText
                            live.clearCompletions()
                        },
                    )
                }
            }
        }

        UiField(
            value = draft,
            onValueChange = { next ->
                draft = next
                val lastWord = next.substringAfterLast(' ')
                if (lastWord.startsWith("@") || lastWord.startsWith("$") || lastWord.startsWith("/")) {
                    val trig = lastWord.take(1)
                    val q = lastWord.drop(1)
                    scope.launch { live.updateCompletions(trig, q) }
                } else {
                    live.clearCompletions()
                }
            },
            placeholder = "Message agent… (@file, \$skill, /command)",
            singleLine = false,
            minLines = 2,
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                UiCheckbox(
                    checked = yoloEnabled,
                    onCheckedChange = { live.setYolo(it) },
                    label = "YOLO (auto-approve)",
                )
                if (usage != null) {
                    val costSuffix = if (!suppressCostOnMobile && usage.costUsd != null) {
                        " · $${((usage.costUsd * 100).toInt() / 100.0)}"
                    } else ""
                    Text(
                        text = "${usage.inputTokens + usage.outputTokens} tok$costSuffix",
                        color = palette.textFaint,
                        fontSize = 11.5.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (isStreaming) {
                    UiButton(
                        text = "Stop",
                        size = ButtonSize.SM,
                        variant = ButtonVariant.DANGER,
                        onClick = { scope.launch { runCatching { live.cancelActiveTurn() } } },
                    )
                    UiButton(
                        text = "Steer",
                        size = ButtonSize.SM,
                        variant = ButtonVariant.PRIMARY,
                        enabled = draft.isNotBlank(),
                        onClick = {
                            val toSend = draft
                            draft = ""
                            scope.launch { runCatching { live.sendPrompt(toSend, steer = true) } }
                        },
                    )
                } else {
                    UiButton(
                        text = "Send",
                        size = ButtonSize.SM,
                        variant = ButtonVariant.PRIMARY,
                        enabled = draft.isNotBlank(),
                        onClick = {
                            val toSend = draft
                            draft = ""
                            scope.launch { runCatching { live.sendPrompt(toSend, steer = false) } }
                        },
                    )
                }
            }
        }
    }
}

internal fun splitMarkdownCodeBlocks(md: String): List<Triple<Boolean, String, String>> {
    val result = mutableListOf<Triple<Boolean, String, String>>()
    var cursor = 0
    while (cursor < md.length) {
        val fenceStart = md.indexOf("```", cursor)
        if (fenceStart < 0) {
            result.add(Triple(false, "", md.substring(cursor)))
            break
        }
        if (fenceStart > cursor) {
            result.add(Triple(false, "", md.substring(cursor, fenceStart)))
        }
        val firstNewline = md.indexOf('\n', fenceStart + 3)
        if (firstNewline < 0) {
            result.add(Triple(false, "", md.substring(fenceStart)))
            break
        }
        val lang = md.substring(fenceStart + 3, firstNewline).trim()
        val fenceEnd = md.indexOf("```", firstNewline + 1)
        if (fenceEnd < 0) {
            result.add(Triple(true, lang, md.substring(firstNewline + 1)))
            break
        }
        result.add(Triple(true, lang, md.substring(firstNewline + 1, fenceEnd).trimEnd('\n')))
        cursor = fenceEnd + 3
    }
    return result
}
