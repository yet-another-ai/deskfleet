package ai.yetanother.deskfleet.ui.management

import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.state.AppController
import ai.yetanother.deskfleet.state.PaneTab
import ai.yetanother.deskfleet.ui.common.*
import ai.yetanother.deskfleet.ui.theme.LocalDeskFleetColors
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Scheduled Tasks View (`ScheduledTasksView.vue` + `ScheduleEditor.vue` + `ScheduleDetail.vue`).
 */
@Composable
fun ScheduledTasksView(
    controller: AppController,
    machineScope: MachineScope,
) {
    val palette = LocalDeskFleetColors.current
    val runtime = remember(machineScope) { controller.runtimeFor(machineScope) }
    val schedules by runtime.schedules.collectAsState()
    val catalog by runtime.catalog.collectAsState()
    val machine by runtime.machine.collectAsState()
    val scope = rememberCoroutineScope()

    var editorOpen by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(machineScope) {
        runCatching { runtime.refreshSchedules() }.onFailure { errorMsg = it.message }
    }

    Column(
        modifier = Modifier.fillMaxSize().background(palette.canvas).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column {
                Text("Scheduled Tasks — ${machine.name}", color = palette.text, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                Text("Automate recurring or manual agent prompts inside a Workspace.", color = palette.textMuted, fontSize = 12.5.sp)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                UiButton("↻ Refresh", size = ButtonSize.SM, onClick = { scope.launch { runtime.refreshSchedules() } })
                UiButton("+ New Schedule", size = ButtonSize.SM, variant = ButtonVariant.PRIMARY, onClick = { editorOpen = true })
            }
        }

        if (!errorMsg.isNullOrEmpty()) ErrorNotice(message = errorMsg!!, onDismiss = { errorMsg = null })

        if (schedules.isEmpty()) {
            Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) {
                Text("No scheduled tasks configured on ${machine.name}.", color = palette.textFaint, fontSize = 13.5.sp)
            }
        } else {
            Column(
                modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                schedules.forEach { task ->
                    val shape = RoundedCornerShape(12.dp)
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(shape)
                            .background(palette.surface)
                            .border(1.dp, palette.border, shape)
                            .padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            StatusDot(online = task.enabled)
                            Text(task.title, color = palette.text, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Text(formatTriggerBadge(task.trigger), color = palette.accent, fontSize = 11.5.sp, fontFamily = FontFamily.Monospace)
                            UiSwitch(
                                checked = task.enabled,
                                onCheckedChange = { next ->
                                    scope.launch {
                                        runCatching {
                                            runtime.updateSchedule(task.id, buildJsonObject { put("enabled", next) })
                                        }.onFailure { errorMsg = it.message }
                                    }
                                },
                            )
                            UiButton(
                                text = "▶ Run now",
                                size = ButtonSize.SM,
                                variant = ButtonVariant.PRIMARY,
                                onClick = {
                                    scope.launch {
                                        runCatching { runtime.runScheduleNow(task.id) }
                                            .onFailure { errorMsg = it.message }
                                    }
                                },
                            )
                            HoldButton(
                                label = "Hold to delete",
                                onConfirmed = {
                                    scope.launch {
                                        runCatching { runtime.deleteSchedule(task.id) }
                                            .onFailure { errorMsg = it.message }
                                    }
                                },
                            )
                        }
                        Text(task.prompt, color = palette.textMuted, fontSize = 12.5.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        task.lastRun?.let { lr ->
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("Last run: ${lr.state}", color = palette.textFaint, fontSize = 11.5.sp)
                                if (!lr.sessionId.isNullOrBlank()) {
                                    UiButton(
                                        text = "Open Session →",
                                        size = ButtonSize.SM,
                                        variant = ButtonVariant.GHOST,
                                        onClick = {
                                            controller.openTab(
                                                PaneTab.AgentSession(
                                                    SessionScope(machineScope.teamId, machineScope.machineId, lr.sessionId),
                                                    task.title,
                                                )
                                            )
                                        },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (editorOpen) {
        ScheduleEditorDialog(
            workspaces = catalog.workspaces,
            providers = catalog.providers,
            onSave = { input ->
                runtime.createSchedule(input)
                editorOpen = false
            },
            onClose = { editorOpen = false },
        )
    }
}

private fun formatTriggerBadge(t: ScheduleTriggerWire): String = when (t.kind) {
    "interval" -> "Every ${t.minutes ?: 60}m"
    "daily" -> "Daily ${t.time ?: "09:00"} (${t.timeZone ?: "UTC"})"
    "weekly" -> "Weekly ${t.time ?: "09:00"}"
    else -> "Manual"
}

@Composable
private fun ScheduleEditorDialog(
    workspaces: List<WorkspaceSummary>,
    providers: List<ProviderSummary>,
    onSave: suspend (ScheduleInputWire) -> Unit,
    onClose: () -> Unit,
) {
    var title by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    var workspaceId by remember(workspaces) { mutableStateOf(workspaces.firstOrNull()?.id.orEmpty()) }
    var providerId by remember(providers) { mutableStateOf(providers.firstOrNull()?.id ?: "codex") }
    var contextKind by remember { mutableStateOf("worktree") }
    var triggerKind by remember { mutableStateOf("daily") } // "manual" | "interval" | "daily" | "weekly"
    var intervalMinutes by remember { mutableIntStateOf(60) }
    var dailyTime by remember { mutableStateOf("09:00") }
    var timeZone by remember { mutableStateOf("UTC") }
    var weekdays by remember { mutableStateOf(setOf(1, 2, 3, 4, 5)) }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    UiDialog(
        open = true,
        onClose = onClose,
        title = "Create Scheduled Task",
        footer = {
            UiButton("Cancel", variant = ButtonVariant.SUBTLE, onClick = onClose)
            UiButton(
                text = "Create Schedule",
                variant = ButtonVariant.PRIMARY,
                loading = busy,
                enabled = title.isNotBlank() && prompt.isNotBlank() && workspaceId.isNotBlank(),
                onClick = {
                    scope.launch {
                        busy = true
                        err = null
                        val trig = when (triggerKind) {
                            "manual" -> ScheduleTriggerWire(kind = "manual")
                            "interval" -> ScheduleTriggerWire(kind = "interval", minutes = intervalMinutes)
                            "weekly" -> ScheduleTriggerWire(kind = "weekly", time = dailyTime, timeZone = timeZone, weekdays = weekdays.sorted())
                            else -> ScheduleTriggerWire(kind = "daily", time = dailyTime, timeZone = timeZone)
                        }
                        val input = ScheduleInputWire(
                            title = title.trim(),
                            prompt = prompt.trim(),
                            workspaceId = workspaceId,
                            enabled = true,
                            target = ScheduleTargetWire(kind = "new", provider = providerId, context = contextKind),
                            trigger = trig,
                        )
                        runCatching { onSave(input) }.onFailure { err = it.message }
                        busy = false
                    }
                },
            )
        },
    ) {
        if (!err.isNullOrEmpty()) ErrorNotice(message = err!!)
        UiField(value = title, onValueChange = { title = it }, label = "Title", placeholder = "Nightly test audit")
        UiSelect(
            label = "Workspace",
            options = workspaces.map { SelectOption(it.id, it.name, it.primaryDirectory) },
            selected = workspaceId,
            onSelected = { workspaceId = it },
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            UiSelect(
                label = "Provider",
                options = providers.ifEmpty { listOf(ProviderSummary("codex", "Codex")) }.map { SelectOption(it.id, it.name) },
                selected = providerId,
                onSelected = { providerId = it },
                modifier = Modifier.weight(1f),
            )
            UiSelect(
                label = "Trigger",
                options = listOf(
                    SelectOption("daily", "Daily"),
                    SelectOption("weekly", "Weekly"),
                    SelectOption("interval", "Interval"),
                    SelectOption("manual", "Manual only"),
                ),
                selected = triggerKind,
                onSelected = { triggerKind = it },
                modifier = Modifier.weight(1f),
            )
        }
        if (triggerKind == "interval") {
            UiNumberField(value = intervalMinutes, onValueChange = { intervalMinutes = it }, label = "Interval (minutes)", min = 1, max = 525_600)
        } else if (triggerKind == "daily" || triggerKind == "weekly") {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                UiTimeField(valueHhMm = dailyTime, onValueChange = { dailyTime = it }, label = "Time (HH:mm)", modifier = Modifier.weight(1f))
                UiField(value = timeZone, onValueChange = { timeZone = it }, label = "IANA Time Zone", placeholder = "Asia/Shanghai", modifier = Modifier.weight(1f))
            }
            if (triggerKind == "weekly") {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    listOf(0 to "Sun", 1 to "Mon", 2 to "Tue", 3 to "Wed", 4 to "Thu", 5 to "Fri", 6 to "Sat").forEach { (d, lbl) ->
                        UiButton(
                            text = lbl,
                            size = ButtonSize.SM,
                            active = d in weekdays,
                            onClick = {
                                val next = weekdays.toMutableSet()
                                if (!next.add(d) && next.size > 1) next.remove(d)
                                weekdays = next
                            },
                        )
                    }
                }
            }
        }
        UiField(value = prompt, onValueChange = { prompt = it }, label = "Agent Prompt", singleLine = false, minLines = 3)
    }
}

/**
 * Cross-Machine Team Search View (`SearchView.vue`).
 */
@Composable
fun SearchView(controller: AppController) {
    val palette = LocalDeskFleetColors.current
    val results by controller.searchResults.collectAsState()
    val selectedTeamId by controller.selectedTeamId.collectAsState()
    val scope = rememberCoroutineScope()

    var query by remember { mutableStateOf("") }
    var kindFilter by remember { mutableStateOf("all") } // "all" | "chat" | "schedule"
    var busy by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().background(palette.canvas).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Search Team History", color = palette.text, fontSize = 19.sp, fontWeight = FontWeight.Bold)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            UiField(
                value = query,
                onValueChange = { q ->
                    query = q
                    scope.launch {
                        busy = true
                        runCatching { controller.runSearch(q, kindFilter) }
                        busy = false
                    }
                },
                placeholder = "Search sessions, prompts, tool outputs, and schedules…",
                modifier = Modifier.weight(1f),
            )
            listOf("all" to "All", "chat" to "Sessions", "schedule" to "Schedules").forEach { (k, lbl) ->
                UiButton(
                    text = lbl,
                    size = ButtonSize.SM,
                    active = kindFilter == k,
                    onClick = {
                        kindFilter = k
                        scope.launch { runCatching { controller.runSearch(query, k) } }
                    },
                )
            }
        }

        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (query.isNotBlank() && results.isEmpty() && !busy) {
                Text("No matching results found.", color = palette.textFaint, fontSize = 13.sp)
            }
            results.forEach { hit ->
                val shape = RoundedCornerShape(10.dp)
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(shape)
                        .background(palette.surface)
                        .border(1.dp, palette.border, shape)
                        .clickable {
                            val tid = selectedTeamId ?: return@clickable
                            if (hit.kind == "schedule") {
                                controller.openTab(PaneTab.Schedules(MachineScope(tid, hit.machineId), "${hit.machineName} Schedules"))
                            } else {
                                controller.openTab(PaneTab.AgentSession(SessionScope(tid, hit.machineId, hit.resourceId), hit.title))
                            }
                        }
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                        Text(hit.title, color = palette.text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                        Text("${hit.machineName} · ${hit.kind}", color = palette.textFaint, fontSize = 11.5.sp)
                    }
                    if (hit.snippet.isNotBlank()) {
                        Text(hit.snippet, color = palette.textMuted, fontSize = 12.5.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

/**
 * Archived Sessions View (`ArchivedSessionsView.vue`):
 * - Supports `Restore` and `HoldButton` (1200ms hold-to-delete permanent destruction).
 */
@Composable
fun ArchivedSessionsView(controller: AppController) {
    val palette = LocalDeskFleetColors.current
    val selectedTeamId by controller.selectedTeamId.collectAsState()
    val machines = controller.currentTeamMachines()
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier.fillMaxSize().background(palette.canvas).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Archived Sessions", color = palette.text, fontSize = 19.sp, fontWeight = FontWeight.Bold)
        Text(
            "Restoring a session recreates cleaned Git worktrees at their saved committed HEADs.",
            color = palette.textMuted,
            fontSize = 12.5.sp,
        )

        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            var totalCount = 0
            if (selectedTeamId != null) {
                machines.forEach { m ->
                    val rt = controller.runtimeFor(MachineScope(selectedTeamId!!, m.id), m)
                    val cat by rt.catalog.collectAsState()
                    cat.archivedSessions.forEach { sess ->
                        totalCount++
                        val shape = RoundedCornerShape(10.dp)
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(shape)
                                .background(palette.surface)
                                .border(1.dp, palette.border, shape)
                                .padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            ProviderBadge(sess.provider)
                            Column(modifier = Modifier.weight(1f)) {
                                Text(sess.title, color = palette.text, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
                                Text("${m.name} · ${sess.context}", color = palette.textFaint, fontSize = 11.5.sp)
                            }
                            UiButton(
                                text = "Restore",
                                size = ButtonSize.SM,
                                variant = ButtonVariant.SUBTLE,
                                onClick = { scope.launch { runCatching { rt.restoreSession(sess.id) } } },
                            )
                            HoldButton(
                                label = "Hold to delete",
                                onConfirmed = { scope.launch { runCatching { rt.deleteArchivedSession(sess.id) } } },
                            )
                        }
                    }
                }
            }
            if (totalCount == 0) {
                Text("No archived sessions across your Team's machines.", color = palette.textFaint, fontSize = 13.5.sp)
            }
        }
    }
}
