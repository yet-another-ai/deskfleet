package ai.yetanother.deskfleet.ui.session

import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.state.*
import ai.yetanother.deskfleet.ui.common.*
import ai.yetanother.deskfleet.ui.details.GitChangesList
import ai.yetanother.deskfleet.ui.details.UnifiedDiffRenderer
import ai.yetanother.deskfleet.ui.theme.LocalDeskFleetColors
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/**
 * New Agent Session Launcher (`NewSessionView.vue`):
 * - Qualifies target by `(teamId, machineId)` (`MachineScope`).
 * - Supports `Worktree` (isolated Git checkout) vs `Directory` (in-place) vs `Machine-scoped` (home directory).
 */
@Composable
fun NewSessionView(
    controller: AppController,
    preselectedMachine: MachineScope? = null,
    preselectedWorkspaceId: String? = null,
) {
    val palette = LocalDeskFleetColors.current
    val selectedTeamId by controller.selectedTeamId.collectAsState()
    val machinesMap by controller.machinesByTeam.collectAsState()
    val machines = selectedTeamId?.let { machinesMap[it] }.orEmpty()
    val scope = rememberCoroutineScope()

    var chosenMachineId by remember(preselectedMachine, machines) {
        mutableStateOf(preselectedMachine?.machineId ?: machines.firstOrNull()?.id.orEmpty())
    }

    val activeRuntime = remember(selectedTeamId, chosenMachineId) {
        if (!selectedTeamId.isNullOrBlank() && chosenMachineId.isNotBlank()) {
            controller.runtimeFor(MachineScope(selectedTeamId!!, chosenMachineId))
        } else null
    }
    val catalog = activeRuntime?.catalog?.collectAsState()?.value

    var chosenWorkspaceId by remember(preselectedWorkspaceId, catalog?.workspaces) {
        mutableStateOf(preselectedWorkspaceId ?: catalog?.workspaces?.firstOrNull()?.id.orEmpty())
    }
    var contextKind by remember { mutableStateOf("worktree") } // "worktree" | "directory"
    var providerId by remember(catalog?.providers) {
        mutableStateOf(catalog?.providers?.firstOrNull()?.id ?: "codex")
    }
    var baseBranch by remember { mutableStateOf("") }
    var promptText by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(palette.accentSoft.copy(alpha = 0.25f), palette.canvas, palette.canvas)
                )
            )
            .padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        val cardShape = RoundedCornerShape(16.dp)
        Column(
            modifier = Modifier
                .widthIn(max = 680.dp)
                .fillMaxWidth()
                .clip(cardShape)
                .background(palette.surface)
                .border(1.dp, palette.border, cardShape)
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                BrandLogo(32.dp)
                Column {
                    Text("Start a New Agent Session", color = palette.text, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                    Text(
                        "Launch an autonomous coding agent in an isolated Git worktree or live directory.",
                        color = palette.textMuted,
                        fontSize = 12.5.sp,
                    )
                }
            }

            if (!error.isNullOrEmpty()) ErrorNotice(message = error!!)

            if (machines.isEmpty()) {
                Text(
                    "Enroll a Machine in this Team first so DeskFleet has an execution host.",
                    color = palette.warning,
                    fontSize = 13.sp,
                )
                UiButton(
                    text = "Add Machine",
                    variant = ButtonVariant.PRIMARY,
                    onClick = { controller.setShowAddMachineDialog(true) },
                )
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    UiSelect(
                        label = "Target Machine",
                        options = machines.map { m ->
                            SelectOption(m.id, "${m.name} (${if (m.online) "online" else "offline"})", m.os)
                        },
                        selected = chosenMachineId,
                        onSelected = { chosenMachineId = it },
                        modifier = Modifier.weight(1f),
                    )
                    val wsOptions = buildList {
                        add(SelectOption("", "Machine Home Directory (No Workspace)"))
                        catalog?.workspaces?.forEach { ws ->
                            add(SelectOption(ws.id, ws.name, ws.primaryDirectory))
                        }
                    }
                    UiSelect(
                        label = "Workspace",
                        options = wsOptions,
                        selected = chosenWorkspaceId,
                        onSelected = { chosenWorkspaceId = it },
                        modifier = Modifier.weight(1f),
                    )
                }

                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    val providers = catalog?.providers?.ifEmpty {
                        listOf(
                            ProviderSummary(id = "codex", name = "Codex"),
                            ProviderSummary(id = "claude-code", name = "Claude Code"),
                            ProviderSummary(id = "gemini", name = "Gemini CLI"),
                        )
                    }.orEmpty()
                    UiSelect(
                        label = "Agent Provider",
                        options = providers.map { SelectOption(it.id, it.name, it.version) },
                        selected = providerId,
                        onSelected = { providerId = it },
                        modifier = Modifier.weight(1f),
                    )
                    UiSelect(
                        label = "Checkout Mode",
                        options = listOf(
                            SelectOption("worktree", "Isolated Git Worktree", "Creates dedicated branch/checkout"),
                            SelectOption("directory", "In-Place Directory", "Works directly in workspace folder"),
                        ),
                        selected = contextKind,
                        onSelected = { contextKind = it },
                        modifier = Modifier.weight(1f),
                    )
                }

                if (contextKind == "worktree" && chosenWorkspaceId.isNotBlank()) {
                    UiField(
                        value = baseBranch,
                        onValueChange = { baseBranch = it },
                        label = "Base Branch (optional)",
                        placeholder = "main",
                        monospace = true,
                    )
                }

                UiField(
                    value = promptText,
                    onValueChange = { promptText = it },
                    label = "Initial Task Prompt",
                    placeholder = "Inspect the repository architecture, run tests, or implement a feature…",
                    singleLine = false,
                    minLines = 4,
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                ) {
                    UiButton(
                        text = "Create & Start Session",
                        variant = ButtonVariant.PRIMARY,
                        loading = busy,
                        enabled = activeRuntime != null,
                        onClick = {
                            val rt = activeRuntime ?: return@UiButton
                            scope.launch {
                                busy = true
                                error = null
                                runCatching {
                                    val sid = rt.createAgentSession(
                                        provider = providerId,
                                        context = if (chosenWorkspaceId.isBlank()) "directory" else contextKind,
                                        workspaceId = chosenWorkspaceId.ifBlank { null },
                                        baseBranch = baseBranch.ifBlank { null },
                                        initialPrompt = promptText.ifBlank { null },
                                    )
                                    val sc = SessionScope(rt.machineScope.teamId, rt.machineScope.machineId, sid)
                                    val title = promptText.lineSequence().firstOrNull()?.take(42)?.ifBlank { null } ?: "New Session"
                                    controller.openTab(PaneTab.AgentSession(sc, title))
                                }.onFailure { error = it.message }
                                busy = false
                            }
                        },
                    )
                }
            }
        }
    }
}

/**
 * Full Live Agent Session View (`SessionView.vue` + `AgentConversation.vue` + `SessionComposer.vue`).
 */
@Composable
fun AgentSessionView(
    controller: AppController,
    sessionScope: SessionScope,
    isMobileLayout: Boolean,
) {
    val palette = LocalDeskFleetColors.current
    val runtime = remember(sessionScope.machineScope) { controller.runtimeFor(sessionScope.machineScope) }
    val live = remember(sessionScope.key) { runtime.getOrCreateSessionController(sessionScope.sessionId) }
    val catalog by runtime.catalog.collectAsState()
    val summary = catalog.sessions.firstOrNull { it.id == sessionScope.sessionId }
        ?: catalog.archivedSessions.firstOrNull { it.id == sessionScope.sessionId }

    val conv by live.conversation.collectAsState()
    val gitStatus by live.gitStatus.collectAsState()
    val completions by live.completions.collectAsState()
    val yolo by live.yoloEnabled.collectAsState()
    val liveConnected by live.liveConnected.collectAsState()
    val errText by live.error.collectAsState()

    var renaming by remember { mutableStateOf(false) }
    var renameDraft by remember(summary?.title, conv.title) {
        mutableStateOf(conv.title ?: summary?.title ?: "Session")
    }
    var mobileChangesOpen by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()

    LaunchedEffect(sessionScope.key) {
        live.hydrateAndSubscribe()
    }
    LaunchedEffect(conv.items.size) {
        if (conv.items.isNotEmpty()) {
            listState.animateScrollToItem(conv.items.lastIndex)
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(palette.canvas)) {
        // Session Header (`SessionHeader.vue`)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(palette.surface)
                .padding(horizontal = 14.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            StatusDot(online = liveConnected, working = conv.isStreaming)
            ProviderBadge(summary?.provider ?: "codex")
            if (renaming) {
                UiField(
                    value = renameDraft,
                    onValueChange = { renameDraft = it },
                    modifier = Modifier.weight(1f),
                    trailing = {
                        UiButton(
                            text = "Save",
                            size = ButtonSize.SM,
                            variant = ButtonVariant.PRIMARY,
                            onClick = {
                                scope.launch {
                                    runCatching { runtime.renameSession(sessionScope.sessionId, renameDraft) }
                                    renaming = false
                                }
                            },
                        )
                    },
                )
            } else {
                Text(
                    text = conv.title ?: summary?.title ?: "Session",
                    color = palette.text,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).clickable { renaming = true },
                )
            }

            summary?.pullRequest?.let { pr ->
                UiButton(
                    text = "PR #${pr.number}",
                    size = ButtonSize.SM,
                    onClick = { if (pr.url.isNotBlank()) controller.hostBridge.openExternalUrl(pr.url) },
                )
            }

            // Desktop External Editor OpenWith Menu (`OpenWith.vue`)
            if (controller.hostBridge.platform.isDesktop) {
                val editors = remember { controller.hostBridge.availableEditors() }
                val workDir = summary?.directories?.firstOrNull()
                    ?: catalog.workspaces.firstOrNull { it.id == summary?.workspaceId }?.primaryDirectory
                if (editors.isNotEmpty() && !workDir.isNullOrBlank()) {
                    var openMenu by remember { mutableStateOf(false) }
                    Box {
                        UiButton(text = "Open in ▾", size = ButtonSize.SM, onClick = { openMenu = true })
                        DropdownMenu(expanded = openMenu, onDismissRequest = { openMenu = false }) {
                            editors.forEach { ed ->
                                DropdownMenuItem(
                                    text = { Text(ed.label) },
                                    onClick = {
                                        openMenu = false
                                        controller.hostBridge.openInEditor(ed.id, workDir)
                                    },
                                )
                            }
                        }
                    }
                }
            }

            UiButton(
                text = "Changes (${gitStatus.files.size})",
                size = ButtonSize.SM,
                active = !isMobileLayout && controller.changesDrawerOpen.collectAsState().value,
                onClick = {
                    if (isMobileLayout) mobileChangesOpen = true else controller.toggleChangesDrawer()
                },
            )
            UiButton(
                text = "Fork",
                size = ButtonSize.SM,
                onClick = {
                    scope.launch {
                        runCatching {
                            val forkedId = runtime.forkSession(sessionScope.sessionId)
                            controller.openTab(
                                PaneTab.AgentSession(
                                    SessionScope(sessionScope.teamId, sessionScope.machineId, forkedId),
                                    "Fork of ${summary?.title ?: "Session"}",
                                )
                            )
                        }
                    }
                },
            )
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(palette.border))

        if (!errText.isNullOrEmpty()) {
            Box(Modifier.padding(horizontal = 14.dp, vertical = 6.dp)) {
                ErrorNotice(
                    message = errText!!,
                    suppressBillingPricing = controller.hostBridge.platform.suppressBillingPricing,
                )
            }
        }

        // Conversation Transcript (`AgentConversation.vue`)
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (conv.items.isEmpty()) {
                item {
                    Box(modifier = Modifier.fillMaxWidth().padding(vertical = 36.dp), contentAlignment = Alignment.Center) {
                        Text(
                            "Send a prompt below to begin collaborating with the agent.",
                            color = palette.textFaint,
                            fontSize = 13.5.sp,
                        )
                    }
                }
            }
            items(conv.items, key = { it.id }) { item ->
                when (item) {
                    is TranscriptItem.UserTurn -> UserTurnCard(item)
                    is TranscriptItem.AssistantTurn -> AssistantTurnCard(
                        turn = item,
                        onCopyCode = { controller.hostBridge.copyToClipboard(it) },
                    )
                    is TranscriptItem.SystemNotice -> Text(
                        item.message,
                        color = palette.textMuted,
                        fontSize = 12.sp,
                    )
                }
            }
        }

        // Interactive Pending Permission Requests (`PendingPermission.vue`)
        conv.permissions.forEach { perm ->
            PermissionApprovalBar(
                permission = perm,
                onRespond = { optId -> scope.launch { live.respondPermission(perm.requestId, optId) } },
            )
        }

        // Interactive Pending Elicitations (`PendingElicitation.vue`)
        conv.elicitations.forEach { elic ->
            ElicitationBar(
                elicitation = elic,
                onRespond = { action, values -> scope.launch { live.respondElicitation(elic.requestId, action, values) } },
            )
        }

        // Composer (`SessionComposer.vue`)
        SessionComposerBar(
            live = live,
            isStreaming = conv.isStreaming,
            usage = conv.usage ?: summary?.usage,
            backlog = conv.backlog,
            completions = completions,
            yoloEnabled = yolo,
            suppressCostOnMobile = controller.hostBridge.platform.suppressBillingPricing,
        )
    }

    BottomSheet(open = mobileChangesOpen, onClose = { mobileChangesOpen = false }) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Working Tree Changes", color = palette.text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            GitChangesList(
                gitStatus = gitStatus,
                onRequestPatch = { live.loadFileDiff(it) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun UserTurnCard(turn: TranscriptItem.UserTurn) {
    val palette = LocalDeskFleetColors.current
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        val shape = RoundedCornerShape(14.dp, 14.dp, 4.dp, 14.dp)
        Box(
            modifier = Modifier
                .widthIn(max = 620.dp)
                .clip(shape)
                .background(palette.accentSoft)
                .border(1.dp, palette.accent.copy(alpha = 0.3f), shape)
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            Text(turn.text, color = palette.text, fontSize = 13.5.sp)
        }
    }
}

@Composable
private fun AssistantTurnCard(
    turn: TranscriptItem.AssistantTurn,
    onCopyCode: (String) -> Unit,
) {
    val palette = LocalDeskFleetColors.current
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (seg in turn.segments) {
            when (seg) {
                is AssistantSegment.MarkdownText -> AgentMarkdownBlock(seg.markdown, onCopyCode)
                is AssistantSegment.ThoughtBlock -> CollapsibleThoughtCard(seg)
                is AssistantSegment.ActivityGroup -> CollapsibleActivityGroupCard(seg)
                is AssistantSegment.PlanCard -> PlanStepsCard(seg.entries)
            }
        }
        if (turn.isStreaming && turn.segments.isEmpty()) {
            Text("Thinking…", color = palette.accent, fontSize = 12.5.sp, fontStyle = FontStyle.Italic)
        }
        if (!turn.error.isNullOrBlank()) {
            ErrorNotice(message = turn.error)
        }
    }
}

@Composable
private fun AgentMarkdownBlock(markdown: String, onCopyCode: (String) -> Unit) {
    val palette = LocalDeskFleetColors.current
    val parts = remember(markdown) { splitMarkdownCodeBlocks(markdown) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        parts.forEach { (isCode, lang, body) ->
            if (isCode) {
                val shape = RoundedCornerShape(9.dp)
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(shape)
                        .background(palette.terminalBg)
                        .border(1.dp, palette.border, shape),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().background(palette.surface).padding(horizontal = 10.dp, vertical = 5.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(lang.ifBlank { "code" }, color = palette.textMuted, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                        UiButton(text = "Copy", size = ButtonSize.SM, variant = ButtonVariant.GHOST, onClick = { onCopyCode(body) })
                    }
                    Text(
                        text = body,
                        color = palette.terminalFg,
                        fontSize = 12.5.sp,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.horizontalScroll(rememberScrollState()).padding(10.dp),
                    )
                }
            } else if (body.isNotBlank()) {
                Text(body.trim(), color = palette.text, fontSize = 13.5.sp, lineHeight = 20.sp)
            }
        }
    }
}

@Composable
private fun CollapsibleThoughtCard(thought: AssistantSegment.ThoughtBlock) {
    val palette = LocalDeskFleetColors.current
    var open by remember { mutableStateOf(thought.active) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(palette.surface)
            .border(1.dp, palette.border, RoundedCornerShape(8.dp))
            .padding(8.dp),
    ) {
        Text(
            text = "${if (open) "▾" else "▸"} ${if (thought.active) "Reasoning…" else "Thought process"}",
            color = palette.textMuted,
            fontSize = 12.sp,
            modifier = Modifier.clickable { open = !open },
        )
        SpringCollapse(visible = open) {
            Text(thought.text, color = palette.textMuted, fontSize = 12.5.sp, modifier = Modifier.padding(top = 6.dp))
        }
    }
}

@Composable
private fun CollapsibleActivityGroupCard(group: AssistantSegment.ActivityGroup) {
    val palette = LocalDeskFleetColors.current
    var expanded by remember { mutableStateOf(group.active) }
    val shape = RoundedCornerShape(9.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(palette.surface)
            .border(1.dp, palette.border, shape)
            .padding(9.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = "${if (expanded) "▾" else "▸"} ${group.calls.size} tool action${if (group.calls.size == 1) "" else "s"}",
                color = if (group.active) palette.accent else palette.textMuted,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
            )
            Text(if (group.active) "Running" else "Done", color = palette.textFaint, fontSize = 11.sp)
        }
        SpringCollapse(visible = expanded) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                group.calls.forEach { tc ->
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(7.dp))
                            .background(palette.canvas)
                            .padding(8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(tc.title, color = palette.text, fontSize = 12.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                            if (tc.isRemoteMcp) {
                                Text("Remote MCP", color = palette.accent, fontSize = 10.5.sp)
                            }
                            Text(tc.status, color = palette.textFaint, fontSize = 10.5.sp)
                        }
                        tc.items.forEach { item ->
                            if (item.kind == "diff" && (!item.oldText.isNullOrEmpty() || !item.newText.isNullOrEmpty())) {
                                UnifiedDiffRenderer(
                                    patch = "@@ -1,1 +1,1 @@\n-${item.oldText.orEmpty()}\n+${item.newText.orEmpty()}"
                                )
                            } else if (!item.text.isNullOrBlank()) {
                                Text(item.text.take(600), color = palette.textMuted, fontSize = 11.5.sp, fontFamily = FontFamily.Monospace)
                            }
                        }
                    }
                }
            }
        }
    }
}
