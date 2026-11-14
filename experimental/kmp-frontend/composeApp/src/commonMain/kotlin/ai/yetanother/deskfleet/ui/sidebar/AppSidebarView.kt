package ai.yetanother.deskfleet.ui.sidebar

import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.state.AppController
import ai.yetanother.deskfleet.state.MachineRuntime
import ai.yetanother.deskfleet.state.PaneTab
import ai.yetanother.deskfleet.ui.common.*
import ai.yetanother.deskfleet.ui.theme.LocalDeskFleetColors
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/**
 * Full Fleet Hierarchy Sidebar (`AppSidebar.vue`):
 * - Desktop (`>=1024dp`): Resizable `200..480dp` rail with `80dp` macOS traffic-light clearance.
 * - Mobile (`<1024dp`): Rendered inside `BottomSheet` with touch-friendly spacing.
 * - Strictly suppresses `BillingEntry` pricing prompts on iOS/Android (`suppressBillingPricing`).
 */
@Composable
fun AppSidebarContent(
    controller: AppController,
    isMobileSheet: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val palette = LocalDeskFleetColors.current
    val platform = controller.hostBridge.platform
    val teams by controller.teams.collectAsState()
    val selectedTeamId by controller.selectedTeamId.collectAsState()
    val machinesMap by controller.machinesByTeam.collectAsState()
    val pinnedKeys by controller.pinnedSessionKeys.collectAsState()
    val account by controller.central.account.collectAsState()
    val wsConnected by controller.central.wsConnected.collectAsState()
    val isSiteAdmin by controller.central.siteAdmin.collectAsState()
    val billing by controller.teamBilling.collectAsState()
    val sidebarWidth by controller.sidebarWidthDp.collectAsState()

    val currentTeam = teams.firstOrNull { it.id == selectedTeamId }
    val machines = selectedTeamId?.let { machinesMap[it] }.orEmpty()

    var workspaceModalTarget by remember { mutableStateOf<MachineRuntime?>(null) }

    Row(modifier = modifier.fillMaxHeight()) {
        Column(
            modifier = Modifier
                .then(
                    if (isMobileSheet) Modifier.fillMaxWidth() else Modifier.width(sidebarWidth.dp)
                )
                .fillMaxHeight()
                .background(palette.sidebar)
                .padding(horizontal = 10.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // macOS traffic-light inset clearance (`80dp` left padding on desktop macOS)
            val topHeaderStartPad = if (!isMobileSheet && platform.hasMacTrafficLights) 74.dp else 0.dp
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = topHeaderStartPad),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                TeamSwitcher(
                    teams = teams,
                    currentTeam = currentTeam,
                    onSelectTeam = { controller.selectTeam(it) },
                    onCreateTeam = { controller.setShowCreateTeamDialog(true) },
                    onOpenTeamSettings = { controller.openTab(PaneTab.TeamSettings("members")) },
                    modifier = Modifier.weight(1f),
                )
                if (!isMobileSheet) {
                    UiButton(
                        text = "⇤",
                        size = ButtonSize.ICON,
                        variant = ButtonVariant.GHOST,
                        onClick = { controller.toggleSidebarCollapsed() },
                    )
                }
            }

            // 4 Primary Navigation Capsules (`SidebarNavigation.vue`)
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                NavCapsule(
                    icon = "+",
                    label = "New",
                    primary = true,
                    onClick = { controller.openTab(PaneTab.NewSession()) },
                    modifier = Modifier.weight(1.2f),
                )
                NavCapsule(
                    icon = "🖥",
                    label = "Screens",
                    onClick = { controller.openTab(PaneTab.RemoteDesktopsGrid) },
                    modifier = Modifier.weight(1f),
                )
                NavCapsule(
                    icon = "⌕",
                    label = "Search",
                    onClick = { controller.openTab(PaneTab.Search) },
                    modifier = Modifier.weight(1f),
                )
                NavCapsule(
                    icon = "⌸",
                    label = "Archive",
                    onClick = { controller.openTab(PaneTab.ArchivedSessions) },
                    modifier = Modifier.weight(1f),
                )
            }

            // Scrollable Fleet Tree: Pinned Sessions + Machines -> Workspaces -> Sessions / Terminals
            Column(
                modifier = Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                // Pinned Sessions section
                if (pinnedKeys.isNotEmpty() && selectedTeamId != null) {
                    val pinnedResolved = machines.flatMap { m ->
                        val rt = controller.runtimeFor(MachineScope(selectedTeamId!!, m.id), m)
                        val cat = rt.catalog.value
                        cat.sessions.mapNotNull { s ->
                            val sc = SessionScope(selectedTeamId!!, m.id, s.id)
                            if (sc.key in pinnedKeys) Triple(sc, m.name, s) else null
                        }
                    }
                    if (pinnedResolved.isNotEmpty()) {
                        Text("PINNED", color = palette.textFaint, fontSize = 10.5.sp, fontWeight = FontWeight.Bold)
                        pinnedResolved.forEach { (sc, mName, sess) ->
                            SessionSidebarRow(
                                session = sess,
                                subtitle = mName,
                                isPinned = true,
                                onOpen = { controller.openTab(PaneTab.AgentSession(sc, sess.title)) },
                                onOpenSplit = { controller.openTab(PaneTab.AgentSession(sc, sess.title), inSplitRight = true) },
                                onTogglePin = { controller.togglePinSession(sc) },
                                onArchive = null,
                            )
                        }
                    }
                }

                // Machines Header
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("MACHINES", color = palette.textFaint, fontSize = 10.5.sp, fontWeight = FontWeight.Bold)
                    UiButton(
                        text = "+ Machine",
                        size = ButtonSize.SM,
                        variant = ButtonVariant.GHOST,
                        onClick = { controller.setShowAddMachineDialog(true) },
                    )
                }

                if (machines.isEmpty()) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(palette.surface)
                            .border(1.dp, palette.border, RoundedCornerShape(10.dp))
                            .padding(12.dp),
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("No machines enrolled yet", color = palette.text, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                            Text(
                                if (platform.supportsLocalDaemon) {
                                    "Enroll this computer or connect a remote Linux/macOS/Windows machine."
                                } else {
                                    "Add a headless server or connect from DeskFleet Desktop."
                                },
                                color = palette.textMuted,
                                fontSize = 12.sp,
                            )
                            UiButton(
                                text = "Add Machine",
                                size = ButtonSize.SM,
                                variant = ButtonVariant.PRIMARY,
                                onClick = { controller.setShowAddMachineDialog(true) },
                            )
                        }
                    }
                } else if (selectedTeamId != null) {
                    for (machine in machines) {
                        val mScope = MachineScope(selectedTeamId!!, machine.id)
                        val runtime = controller.runtimeFor(mScope, machine)
                        MachineTreeSection(
                            controller = controller,
                            runtime = runtime,
                            pinnedKeys = pinnedKeys,
                            onCreateWorkspace = { workspaceModalTarget = runtime },
                        )
                    }
                }
            }

            // Billing / Plan Entry (Strictly suppressed on iOS/Android per Capacitor parity!)
            if (!platform.suppressBillingPricing && billing != null) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(9.dp))
                        .background(palette.surface)
                        .border(1.dp, palette.border, RoundedCornerShape(9.dp))
                        .clickable { controller.openTab(PaneTab.TeamSettings("billing")) }
                        .padding(horizontal = 10.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column {
                        Text(
                            "Plan: ${billing!!.plan.uppercase()}",
                            color = palette.text,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            "${billing!!.usage.activeSessionCount} active sessions",
                            color = palette.textMuted,
                            fontSize = 11.sp,
                        )
                    }
                    Text("Manage →", color = palette.accent, fontSize = 11.5.sp)
                }
            }

            // Account Footer
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(palette.surface)
                    .border(1.dp, palette.border, RoundedCornerShape(10.dp))
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                UserAvatar(
                    name = account.user?.name.orEmpty(),
                    email = account.user?.email.orEmpty(),
                    size = 28.dp,
                )
                Column(modifier = Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        Text(
                            text = account.user?.name?.ifBlank { account.user?.email } ?: "Account",
                            color = palette.text,
                            fontSize = 12.5.sp,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        StatusDot(online = wsConnected)
                    }
                    Text(
                        text = if (wsConnected) "Realtime connected" else "Reconnecting…",
                        color = palette.textFaint,
                        fontSize = 10.5.sp,
                        maxLines = 1,
                    )
                }
                if (isSiteAdmin) {
                    UiButton(
                        text = "Admin",
                        size = ButtonSize.SM,
                        variant = ButtonVariant.GHOST,
                        onClick = { controller.openTab(PaneTab.SiteAdmin) },
                    )
                }
                UiButton(
                    text = "⚙",
                    size = ButtonSize.ICON,
                    variant = ButtonVariant.GHOST,
                    onClick = { controller.openTab(PaneTab.Settings("account")) },
                )
            }
        }

        // Desktop Resize Handle (`200..480dp`)
        if (!isMobileSheet) {
            Box(
                modifier = Modifier
                    .width(5.dp)
                    .fillMaxHeight()
                    .background(palette.border)
                    .pointerInput(Unit) {
                        detectHorizontalDragGestures { _, dragAmount ->
                            controller.setSidebarWidth(controller.sidebarWidthDp.value + dragAmount / density)
                        }
                    }
            )
        }
    }

    if (workspaceModalTarget != null) {
        CreateWorkspaceDialog(
            runtime = workspaceModalTarget!!,
            onClose = { workspaceModalTarget = null },
        )
    }
}

@Composable
private fun TeamSwitcher(
    teams: List<TeamSummary>,
    currentTeam: TeamSummary?,
    onSelectTeam: (String) -> Unit,
    onCreateTeam: () -> Unit,
    onOpenTeamSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalDeskFleetColors.current
    var open by remember { mutableStateOf(false) }

    Box(modifier = modifier) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .clickable { open = true }
                .padding(horizontal = 6.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            BrandLogo(24.dp)
            Text(
                text = currentTeam?.name ?: "Select Team",
                color = palette.text,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Text("▾", color = palette.textMuted, fontSize = 11.sp)
        }

        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            modifier = Modifier.background(palette.surfaceElevated),
        ) {
            teams.forEach { team ->
                DropdownMenuItem(
                    text = {
                        Text(
                            team.name,
                            color = if (team.id == currentTeam?.id) palette.accent else palette.text,
                            fontWeight = if (team.id == currentTeam?.id) FontWeight.SemiBold else FontWeight.Normal,
                        )
                    },
                    onClick = {
                        onSelectTeam(team.id)
                        open = false
                    },
                )
            }
            DropdownMenuItem(
                text = { Text("Team & AI Usage…", color = palette.textMuted) },
                onClick = {
                    open = false
                    onOpenTeamSettings()
                },
            )
            DropdownMenuItem(
                text = { Text("+ New Team…", color = palette.accent) },
                onClick = {
                    open = false
                    onCreateTeam()
                },
            )
        }
    }
}

@Composable
private fun NavCapsule(
    icon: String,
    label: String,
    primary: Boolean = false,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalDeskFleetColors.current
    val shape = RoundedCornerShape(8.dp)
    Row(
        modifier = modifier
            .height(30.dp)
            .clip(shape)
            .background(if (primary) palette.action else palette.control)
            .border(1.dp, if (primary) Color.Transparent else palette.border, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally),
    ) {
        Text(icon, color = if (primary) palette.actionText else palette.text, fontSize = 12.sp)
        Text(
            label,
            color = if (primary) palette.actionText else palette.text,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
        )
    }
}

@Composable
private fun MachineTreeSection(
    controller: AppController,
    runtime: MachineRuntime,
    pinnedKeys: Set<String>,
    onCreateWorkspace: () -> Unit,
) {
    val palette = LocalDeskFleetColors.current
    val machine by runtime.machine.collectAsState()
    val catalog by runtime.catalog.collectAsState()
    val transportBadge by runtime.transportBadge.collectAsState()
    val scope = rememberCoroutineScope()
    var expanded by remember { mutableStateOf(true) }

    val cardShape = RoundedCornerShape(10.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(cardShape)
            .background(palette.surface)
            .border(1.dp, palette.border, cardShape)
            .padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // Machine Header Row
        Row(
            modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            StatusDot(online = machine.online)
            Text(
                text = machine.name,
                color = palette.text,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (transportBadge != "idle") {
                Text(
                    text = transportBadge,
                    color = palette.accent,
                    fontSize = 9.5.sp,
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(palette.accentSoft)
                        .padding(horizontal = 4.dp, vertical = 1.dp),
                )
            }
            Text(if (expanded) "▾" else "▸", color = palette.textMuted, fontSize = 11.sp)
        }

        SpringCollapse(visible = expanded) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                // Machine Remote Control Action Bar
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    MiniChip("+ Dir", onClick = onCreateWorkspace)
                    MiniChip("Term", onClick = {
                        scope.launch {
                            runCatching {
                                val live = runtime.dialNewTerminal()
                                controller.openTab(
                                    PaneTab.Terminal(runtime.machineScope, live.terminalId, "${machine.name} Terminal")
                                )
                            }
                        }
                    })
                    MiniChip("Files", onClick = {
                        controller.openTab(PaneTab.Files(runtime.machineScope, "${machine.name} Files"))
                    })
                    MiniChip("Screen", onClick = {
                        controller.openTab(PaneTab.RemoteDesktop(runtime.machineScope, "${machine.name} Desktop"))
                    })
                    MiniChip("Stats", onClick = {
                        controller.openTab(PaneTab.SystemStatusTab(runtime.machineScope, "${machine.name} System"))
                    })
                    MiniChip("Cron", onClick = {
                        controller.openTab(PaneTab.Schedules(runtime.machineScope, "${machine.name} Schedules"))
                    })
                }

                // Workspaces & Sessions
                for (ws in catalog.workspaces) {
                    val wsSessions = catalog.sessions.filter { it.workspaceId == ws.id }
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(start = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                text = "📁 ${ws.name}",
                                color = palette.textMuted,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                text = "+ Session",
                                color = palette.accent,
                                fontSize = 11.sp,
                                modifier = Modifier.clickable {
                                    controller.openTab(
                                        PaneTab.NewSession(
                                            preselectedMachine = runtime.machineScope,
                                            preselectedWorkspaceId = ws.id,
                                        )
                                    )
                                },
                            )
                        }
                        wsSessions.forEach { sess ->
                            val sc = SessionScope(runtime.machineScope.teamId, runtime.machineScope.machineId, sess.id)
                            SessionSidebarRow(
                                session = sess,
                                isPinned = sc.key in pinnedKeys,
                                onOpen = { controller.openTab(PaneTab.AgentSession(sc, sess.title)) },
                                onOpenSplit = { controller.openTab(PaneTab.AgentSession(sc, sess.title), inSplitRight = true) },
                                onTogglePin = { controller.togglePinSession(sc) },
                                onArchive = { scope.launch { runCatching { runtime.archiveSession(sess.id) } } },
                            )
                        }
                    }
                }

                // Machine-scoped Sessions (without workspaceId)
                val unboundSessions = catalog.sessions.filter { it.workspaceId.isNullOrBlank() }
                unboundSessions.forEach { sess ->
                    val sc = SessionScope(runtime.machineScope.teamId, runtime.machineScope.machineId, sess.id)
                    SessionSidebarRow(
                        session = sess,
                        isPinned = sc.key in pinnedKeys,
                        onOpen = { controller.openTab(PaneTab.AgentSession(sc, sess.title)) },
                        onOpenSplit = { controller.openTab(PaneTab.AgentSession(sc, sess.title), inSplitRight = true) },
                        onTogglePin = { controller.togglePinSession(sc) },
                        onArchive = { scope.launch { runCatching { runtime.archiveSession(sess.id) } } },
                    )
                }

                // Active PTY Terminals
                if (catalog.terminals.isNotEmpty()) {
                    Text("Terminals", color = palette.textFaint, fontSize = 10.5.sp)
                    catalog.terminals.forEach { term ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(6.dp))
                                .clickable {
                                    scope.launch {
                                        runCatching { runtime.attachTerminalSession(term) }
                                        controller.openTab(
                                            PaneTab.Terminal(runtime.machineScope, term.id, term.title)
                                        )
                                    }
                                }
                                .padding(horizontal = 6.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text("❯_ ${term.title}", color = palette.text, fontSize = 12.sp, maxLines = 1)
                            Text(
                                "✕",
                                color = palette.textFaint,
                                fontSize = 11.sp,
                                modifier = Modifier.clickable {
                                    scope.launch { runtime.hangupTerminal(term.id) }
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MiniChip(label: String, onClick: () -> Unit) {
    val palette = LocalDeskFleetColors.current
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(palette.control)
            .border(1.dp, palette.border, RoundedCornerShape(6.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 7.dp, vertical = 3.dp),
    ) {
        Text(label, color = palette.textMuted, fontSize = 11.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun SessionSidebarRow(
    session: SessionSummary,
    subtitle: String? = null,
    isPinned: Boolean,
    onOpen: () -> Unit,
    onOpenSplit: () -> Unit,
    onTogglePin: () -> Unit,
    onArchive: (() -> Unit)?,
) {
    val palette = LocalDeskFleetColors.current
    var menuOpen by remember { mutableStateOf(false) }

    Box {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(7.dp))
                .clickable(onClick = onOpen)
                .padding(horizontal = 6.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            StatusDot(
                online = true,
                working = session.isWorking,
                attention = session.needsAttention,
            )
            ProviderBadge(session.provider)
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = session.title,
                    color = palette.text,
                    fontSize = 12.5.sp,
                    fontWeight = if (session.unread) FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (!subtitle.isNullOrEmpty() || session.pullRequest != null) {
                    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        if (!subtitle.isNullOrEmpty()) {
                            Text(subtitle, color = palette.textFaint, fontSize = 10.5.sp)
                        }
                        session.pullRequest?.let { pr ->
                            Text("#${pr.number}", color = palette.accent, fontSize = 10.5.sp)
                        }
                    }
                }
            }
            if (session.unread) {
                Box(Modifier.size(6.dp).clip(CircleShape).background(palette.accent))
            }
            Text(
                "⋯",
                color = palette.textFaint,
                fontSize = 12.sp,
                modifier = Modifier.clickable { menuOpen = true }.padding(horizontal = 3.dp),
            )
        }
        DropdownMenu(
            expanded = menuOpen,
            onDismissRequest = { menuOpen = false },
            modifier = Modifier.background(palette.surfaceElevated),
        ) {
            DropdownMenuItem(
                text = { Text(if (isPinned) "Unpin session" else "Pin session", color = palette.text) },
                onClick = {
                    menuOpen = false
                    onTogglePin()
                },
            )
            DropdownMenuItem(
                text = { Text("Open in split pane", color = palette.text) },
                onClick = {
                    menuOpen = false
                    onOpenSplit()
                },
            )
            if (onArchive != null) {
                DropdownMenuItem(
                    text = { Text("Archive session", color = palette.danger) },
                    onClick = {
                        menuOpen = false
                        onArchive()
                    },
                )
            }
        }
    }
}

@Composable
private fun CreateWorkspaceDialog(
    runtime: MachineRuntime,
    onClose: () -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var directoryPath by remember { mutableStateOf("") }
    var showPicker by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    UiDialog(
        open = true,
        onClose = onClose,
        title = "Create Workspace on ${runtime.machine.value.name}",
        subtitle = "Workspaces own ordered repository or project directories on this Machine.",
        footer = {
            UiButton(text = "Cancel", variant = ButtonVariant.SUBTLE, onClick = onClose)
            UiButton(
                text = "Create Workspace",
                variant = ButtonVariant.PRIMARY,
                loading = busy,
                enabled = name.isNotBlank() && directoryPath.isNotBlank(),
                onClick = {
                    scope.launch {
                        busy = true
                        error = null
                        runCatching {
                            runtime.createWorkspace(name, listOf(directoryPath))
                            onClose()
                        }.onFailure { error = it.message }
                        busy = false
                    }
                },
            )
        },
    ) {
        if (!error.isNullOrEmpty()) ErrorNotice(message = error!!)
        UiField(value = name, onValueChange = { name = it }, label = "Workspace Name", placeholder = "deskfleet")
        UiField(
            value = directoryPath,
            onValueChange = { directoryPath = it },
            label = "Primary Directory Path",
            placeholder = "/Users/dev/deskfleet",
            monospace = true,
            trailing = {
                UiButton(text = "Browse…", size = ButtonSize.SM, onClick = { showPicker = true })
            },
        )
    }

    FolderPickerDialog(
        open = showPicker,
        title = "Choose Directory on ${runtime.machine.value.name}",
        loadDirectory = { path -> runtime.ensureFilesClient().list(path) },
        onPicked = { picked ->
            directoryPath = picked
            if (name.isBlank()) {
                name = picked.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
            }
        },
        onClose = { showPicker = false },
    )
}
