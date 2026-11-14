package ai.yetanother.deskfleet.ui.chrome

import ai.yetanother.deskfleet.state.AppController
import ai.yetanother.deskfleet.state.PaneTab
import ai.yetanother.deskfleet.transport.currentTimeMillis
import ai.yetanother.deskfleet.ui.common.*
import ai.yetanother.deskfleet.ui.details.GitChangesDrawer
import ai.yetanother.deskfleet.ui.management.*
import ai.yetanother.deskfleet.ui.remote.*
import ai.yetanother.deskfleet.ui.session.AgentSessionView
import ai.yetanother.deskfleet.ui.session.NewSessionView
import ai.yetanother.deskfleet.ui.sidebar.AppSidebarContent
import ai.yetanother.deskfleet.ui.terminal.TerminalWorkspaceView
import ai.yetanother.deskfleet.ui.theme.LocalDeskFleetColors
import ai.yetanother.deskfleet.ui.theme.rememberSpringController
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt

/**
 * Desktop Multi-Pane Window Manager (`>=1024dp`):
 * - Resizable `AppSidebarContent` + Left/Right split tab panes + right-side `GitChangesDrawer`.
 * - Preserves `darwin` `80dp` left traffic-light inset when sidebar is collapsed and `win32`/`linux` right window-control inset.
 */
@Composable
fun DesktopWorkspaceShell(controller: AppController) {
    val palette = LocalDeskFleetColors.current
    val platform = controller.hostBridge.platform
    val sidebarCollapsed by controller.sidebarCollapsed.collectAsState()
    val leftTabs by controller.leftTabs.collectAsState()
    val leftActiveId by controller.leftActiveTabId.collectAsState()
    val rightTabs by controller.rightTabs.collectAsState()
    val rightActiveId by controller.rightActiveTabId.collectAsState()
    val activeSide by controller.activePaneSide.collectAsState()
    val changesOpen by controller.changesDrawerOpen.collectAsState()

    val leftActiveTab = leftTabs.firstOrNull { it.id == leftActiveId } ?: leftTabs.firstOrNull() ?: PaneTab.NewSession()
    val rightActiveTab = rightTabs.firstOrNull { it.id == rightActiveId }
    val focusedTab = if (activeSide == "right" && rightActiveTab != null) rightActiveTab else leftActiveTab

    Row(modifier = Modifier.fillMaxSize().background(palette.canvas)) {
        if (!sidebarCollapsed) {
            AppSidebarContent(controller = controller, isMobileSheet = false)
        }

        // Main Multi-Pane Stage
        Row(modifier = Modifier.weight(1f).fillMaxHeight()) {
            // Left Pane
            Column(modifier = Modifier.weight(1f).fillMaxHeight()) {
                PaneTabStrip(
                    tabs = leftTabs,
                    activeTabId = leftActiveTab.id,
                    isFocusedPane = activeSide == "left" || rightTabs.isEmpty(),
                    leadingStartPad = if (sidebarCollapsed && platform.hasMacTrafficLights) 76.dp else 6.dp,
                    trailingEndPad = if (rightTabs.isEmpty() && platform.hasRightWindowControlsInset) 136.dp else 8.dp,
                    showSidebarExpandButton = sidebarCollapsed,
                    onExpandSidebar = { controller.toggleSidebarCollapsed() },
                    onSelectTab = { controller.focusTab(it, inRightPane = false) },
                    onCloseTab = { controller.closeTab(it, fromRightPane = false) },
                    onNewTab = { controller.openTab(PaneTab.NewSession()) },
                    onToggleSplit = { controller.toggleSplitCurrentTab() },
                    isSplitOpen = rightTabs.isNotEmpty(),
                )
                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    RenderPaneTab(controller = controller, tab = leftActiveTab, isMobileLayout = false)
                }
            }

            // Optional Split Right Pane
            if (rightTabs.isNotEmpty() && rightActiveTab != null) {
                Box(Modifier.width(1.dp).fillMaxHeight().background(palette.borderStrong))
                Column(modifier = Modifier.weight(1f).fillMaxHeight()) {
                    PaneTabStrip(
                        tabs = rightTabs,
                        activeTabId = rightActiveTab.id,
                        isFocusedPane = activeSide == "right",
                        leadingStartPad = 6.dp,
                        trailingEndPad = if (platform.hasRightWindowControlsInset) 136.dp else 8.dp,
                        showSidebarExpandButton = false,
                        onExpandSidebar = {},
                        onSelectTab = { controller.focusTab(it, inRightPane = true) },
                        onCloseTab = { controller.closeTab(it, fromRightPane = true) },
                        onNewTab = { controller.openTab(PaneTab.NewSession(), inSplitRight = true) },
                        onToggleSplit = { controller.toggleSplitCurrentTab() },
                        isSplitOpen = true,
                    )
                    Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                        RenderPaneTab(controller = controller, tab = rightActiveTab, isMobileLayout = false)
                    }
                }
            }

            // Right-hand Git Changes Drawer when focused tab is an AgentSession
            if (changesOpen && focusedTab is PaneTab.AgentSession) {
                val rt = controller.runtimeFor(focusedTab.sessionScope.machineScope)
                val sessLive = rt.getOrCreateSessionController(focusedTab.sessionScope.sessionId)
                GitChangesDrawer(
                    sessionController = sessLive,
                    onClose = { controller.toggleChangesDrawer() },
                )
            }
        }
    }
}

@Composable
private fun PaneTabStrip(
    tabs: List<PaneTab>,
    activeTabId: String,
    isFocusedPane: Boolean,
    leadingStartPad: androidx.compose.ui.unit.Dp,
    trailingEndPad: androidx.compose.ui.unit.Dp,
    showSidebarExpandButton: Boolean,
    onExpandSidebar: () -> Unit,
    onSelectTab: (String) -> Unit,
    onCloseTab: (String) -> Unit,
    onNewTab: () -> Unit,
    onToggleSplit: () -> Unit,
    isSplitOpen: Boolean,
) {
    val palette = LocalDeskFleetColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(38.dp)
            .background(palette.sidebar)
            .border(1.dp, palette.border)
            .padding(start = leadingStartPad, end = trailingEndPad),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (showSidebarExpandButton) {
            UiButton("⇥", size = ButtonSize.ICON, variant = ButtonVariant.GHOST, onClick = onExpandSidebar)
        }
        Row(
            modifier = Modifier.weight(1f).horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            tabs.forEach { tab ->
                val active = tab.id == activeTabId
                val shape = RoundedCornerShape(7.dp)
                Row(
                    modifier = Modifier
                        .height(28.dp)
                        .clip(shape)
                        .background(if (active) palette.surface else Color.Transparent)
                        .border(
                            1.dp,
                            if (active && isFocusedPane) palette.borderStrong else Color.Transparent,
                            shape,
                        )
                        .clickable { onSelectTab(tab.id) }
                        .padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = tab.title,
                        color = if (active) palette.text else palette.textMuted,
                        fontSize = 12.sp,
                        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (tabs.size > 1 || tab !is PaneTab.NewSession) {
                        Text(
                            text = "✕",
                            color = palette.textFaint,
                            fontSize = 10.5.sp,
                            modifier = Modifier.clickable { onCloseTab(tab.id) },
                        )
                    }
                }
            }
            UiButton("+", size = ButtonSize.ICON, variant = ButtonVariant.GHOST, onClick = onNewTab)
        }
        UiButton(
            text = if (isSplitOpen) "Unsplit" else "Split ◫",
            size = ButtonSize.SM,
            variant = ButtonVariant.GHOST,
            onClick = onToggleSplit,
        )
    }
}

/**
 * Mobile / Compact `<1024dp` Window Manager:
 * - Top bar with `☰` BottomSheet Sidebar trigger, active title, and `⊞` 3-column zoomed Overview Grid toggle!
 * - Spring-driven horizontal swipe between open windows (`SpringController`).
 */
@Composable
fun MobileWorkspaceShell(controller: AppController) {
    val palette = LocalDeskFleetColors.current
    val tabs by controller.leftTabs.collectAsState()
    val activeId by controller.leftActiveTabId.collectAsState()
    val sidebarSheetOpen by controller.mobileSidebarOpen.collectAsState()
    val overviewOpen by controller.mobileOverviewOpen.collectAsState()

    val activeIdx = tabs.indexOfFirst { it.id == activeId }.coerceAtLeast(0)
    val activeTab = tabs.getOrElse(activeIdx) { PaneTab.NewSession() }
    val swipeSpring = rememberSpringController(initialValue = 0f, duration = 0.36, bounce = 0.12)

    Box(modifier = Modifier.fillMaxSize().background(palette.canvas).statusBarsPadding().navigationBarsPadding()) {
        Column(modifier = Modifier.fillMaxSize()) {
            // Compact Mobile Top Header
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(46.dp)
                    .background(palette.sidebar)
                    .border(1.dp, palette.border)
                    .padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                UiButton("☰", size = ButtonSize.ICON, variant = ButtonVariant.GHOST, onClick = {
                    controller.setMobileSidebarOpen(true)
                })
                Text(
                    text = activeTab.title,
                    color = palette.text,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                UiButton(
                    text = "⊞ ${tabs.size}",
                    size = ButtonSize.SM,
                    active = overviewOpen,
                    onClick = { controller.setMobileOverviewOpen(!overviewOpen) },
                )
            }

            if (overviewOpen) {
                // 3-Column Zoomed Window Overview Grid
                Column(
                    modifier = Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text("Open Windows (${tabs.size})", color = palette.text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                        UiButton("+ New Window", size = ButtonSize.SM, variant = ButtonVariant.PRIMARY, onClick = {
                            controller.openTab(PaneTab.NewSession())
                        })
                    }
                    tabs.chunked(3).forEach { rowTabs ->
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                            rowTabs.forEach { t ->
                                val isCurrent = t.id == activeTab.id
                                val shape = RoundedCornerShape(12.dp)
                                Column(
                                    modifier = Modifier
                                        .weight(1f)
                                        .height(130.dp)
                                        .clip(shape)
                                        .background(palette.surface)
                                        .border(if (isCurrent) 2.dp else 1.dp, if (isCurrent) palette.accent else palette.border, shape)
                                        .clickable {
                                            controller.focusTab(t.id)
                                            controller.setMobileOverviewOpen(false)
                                        }
                                        .padding(10.dp),
                                    verticalArrangement = Arrangement.SpaceBetween,
                                ) {
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                        Text(t.title, color = palette.text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, modifier = Modifier.weight(1f))
                                        Text("✕", color = palette.textFaint, fontSize = 12.sp, modifier = Modifier.clickable {
                                            controller.closeTab(t.id)
                                        })
                                    }
                                    Text(t.id.substringBefore(':'), color = palette.textFaint, fontSize = 10.5.sp)
                                }
                            }
                            repeat(3 - rowTabs.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                }
            } else {
                // Active Window Stage with Horizontal Edge-Swipe Switcher
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .offset { IntOffset(swipeSpring.value.roundToInt(), 0) }
                        .pointerInput(tabs, activeIdx) {
                            if (tabs.size <= 1) return@pointerInput
                            detectHorizontalDragGestures(
                                onHorizontalDrag = { _, dragAmount ->
                                    swipeSpring.dragTo((swipeSpring.value + dragAmount * 0.45f).coerceIn(-120f, 120f), currentTimeMillis())
                                },
                                onDragEnd = {
                                    when {
                                        swipeSpring.value < -70f && activeIdx < tabs.lastIndex -> {
                                            controller.focusTab(tabs[activeIdx + 1].id)
                                        }
                                        swipeSpring.value > 70f && activeIdx > 0 -> {
                                            controller.focusTab(tabs[activeIdx - 1].id)
                                        }
                                    }
                                    swipeSpring.endDrag(0f, currentTimeMillis())
                                },
                            )
                        },
                ) {
                    RenderPaneTab(controller = controller, tab = activeTab, isMobileLayout = true)
                }
            }
        }

        // Mobile Sidebar Bottom Sheet
        BottomSheet(
            open = sidebarSheetOpen,
            onClose = { controller.setMobileSidebarOpen(false) },
        ) {
            AppSidebarContent(controller = controller, isMobileSheet = true)
        }
    }
}

@Composable
fun RenderPaneTab(
    controller: AppController,
    tab: PaneTab,
    isMobileLayout: Boolean,
) {
    when (tab) {
        is PaneTab.NewSession -> NewSessionView(
            controller = controller,
            preselectedMachine = tab.preselectedMachine,
            preselectedWorkspaceId = tab.preselectedWorkspaceId,
        )
        is PaneTab.AgentSession -> AgentSessionView(
            controller = controller,
            sessionScope = tab.sessionScope,
            isMobileLayout = isMobileLayout,
        )
        is PaneTab.Terminal -> TerminalWorkspaceView(
            controller = controller,
            machineScope = tab.machineScope,
            terminalId = tab.terminalId,
            isMobileLayout = isMobileLayout,
        )
        is PaneTab.RemoteDesktop -> RemoteDesktopView(
            controller = controller,
            machineScope = tab.machineScope,
        )
        PaneTab.RemoteDesktopsGrid -> RemoteDesktopsGridView(controller = controller)
        is PaneTab.Files -> FileTransferPanelView(
            controller = controller,
            machineScope = tab.machineScope,
            isMobileLayout = isMobileLayout,
        )
        is PaneTab.SystemStatusTab -> SystemStatusPanelView(
            controller = controller,
            machineScope = tab.machineScope,
        )
        is PaneTab.Schedules -> ScheduledTasksView(
            controller = controller,
            machineScope = tab.machineScope,
        )
        PaneTab.Search -> SearchView(controller = controller)
        PaneTab.ArchivedSessions -> ArchivedSessionsView(controller = controller)
        is PaneTab.TeamSettings -> TeamSettingsView(controller = controller, initialSection = tab.initialSection)
        is PaneTab.Settings -> SettingsView(controller = controller, initialSection = tab.initialSection)
        PaneTab.SiteAdmin -> SiteAdminView(controller = controller)
    }
}
