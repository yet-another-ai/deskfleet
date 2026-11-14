package ai.yetanother.deskfleet.state

import ai.yetanother.deskfleet.platform.HostBridge
import ai.yetanother.deskfleet.platform.LocalDaemonStatus
import ai.yetanother.deskfleet.platform.createPlatformHostBridge
import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.transport.*
import ai.yetanother.deskfleet.ui.theme.AppearancePreferences
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * Window / tab content kinds matching every DeskFleet workspace & settings view.
 */
sealed interface PaneTab {
    val id: String
    val title: String

    data class NewSession(
        override val id: String = "new-session",
        val preselectedMachine: MachineScope? = null,
        val preselectedWorkspaceId: String? = null,
    ) : PaneTab {
        override val title: String = "New Session"
    }

    data class AgentSession(
        val sessionScope: SessionScope,
        override val title: String,
    ) : PaneTab {
        override val id: String = "session:${sessionScope.key}"
    }

    data class Terminal(
        val machineScope: MachineScope,
        val terminalId: String,
        override val title: String = "Terminal",
    ) : PaneTab {
        override val id: String = "terminal:${machineScope.key}:$terminalId"
    }

    data class RemoteDesktop(
        val machineScope: MachineScope,
        override val title: String,
    ) : PaneTab {
        override val id: String = "desktop:${machineScope.key}"
    }

    data object RemoteDesktopsGrid : PaneTab {
        override val id: String = "remote-desktops"
        override val title: String = "Remote Desktops"
    }

    data class Files(
        val machineScope: MachineScope,
        override val title: String,
    ) : PaneTab {
        override val id: String = "files:${machineScope.key}"
    }

    data class SystemStatusTab(
        val machineScope: MachineScope,
        override val title: String,
    ) : PaneTab {
        override val id: String = "system:${machineScope.key}"
    }

    data class Schedules(
        val machineScope: MachineScope,
        override val title: String,
    ) : PaneTab {
        override val id: String = "schedules:${machineScope.key}"
    }

    data object Search : PaneTab {
        override val id: String = "search"
        override val title: String = "Search"
    }

    data object ArchivedSessions : PaneTab {
        override val id: String = "archive"
        override val title: String = "Archived Sessions"
    }

    data class TeamSettings(val initialSection: String = "members") : PaneTab {
        override val id: String = "team-settings"
        override val title: String = "Team & Usage"
    }

    data class Settings(val initialSection: String = "account") : PaneTab {
        override val id: String = "settings"
        override val title: String = "Settings"
    }

    data object SiteAdmin : PaneTab {
        override val id: String = "site-admin"
        override val title: String = "Site Administration"
    }
}

@Serializable
private data class PersistedUiState(
    val selectedTeamId: String? = null,
    val pinnedSessionKeys: List<String> = emptyList(),
    val onboardingCompleted: Boolean = false,
    val sidebarWidthDp: Float = 272f,
)

/**
 * Root multiplatform application store orchestrating:
 * - Auth (`SignInForm`, browser PKCE, registration, recovery, `ReauthDialog`)
 * - Platform-aware onboarding (`WelcomePage`, `TeamOnboarding`, `AddMachineDialog`)
 * - Team -> `(teamId, machineId)` `MachineRuntime` map -> Workspace -> Session / Terminal / Files / Desktop / System / Schedules
 * - Desktop split-pane window manager + `<1024dp` mobile swipe & 3-column overview grid
 * - Billing, AI Usage, Search, NAT diagnostics, Updates, and Site Admin.
 */
class AppController(
    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
    val hostBridge: HostBridge = createPlatformHostBridge(),
    private val daemonDirOverride: String? = null,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
        explicitNulls = false
    }

    private val initialAccount: SavedAccountProfile = runCatching {
        hostBridge.readPersistedState("account.json")?.let {
            json.decodeFromString(SavedAccountProfile.serializer(), it)
        }
    }.getOrNull() ?: SavedAccountProfile()

    val central = HttpCentralClient(
        scope = scope,
        initialAccount = initialAccount,
        cookieOnlyMode = hostBridge.platform.usesCookieSessionOnly,
        persistAccount = { profile ->
            runCatching {
                hostBridge.writePersistedState(
                    "account.json",
                    json.encodeToString(SavedAccountProfile.serializer(), profile),
                )
            }
        },
    )

    private val initialPrefs: AppearancePreferences = runCatching {
        hostBridge.readPersistedState("preferences.json")?.let {
            json.decodeFromString(AppearancePreferences.serializer(), it)
        }
    }.getOrNull() ?: AppearancePreferences()

    private val initialUiState: PersistedUiState = runCatching {
        hostBridge.readPersistedState("ui-state.json")?.let {
            json.decodeFromString(PersistedUiState.serializer(), it)
        }
    }.getOrNull() ?: PersistedUiState()

    private val _preferences = MutableStateFlow(initialPrefs)
    val preferences: StateFlow<AppearancePreferences> = _preferences.asStateFlow()

    private val _onboardingCompleted = MutableStateFlow(
        initialUiState.onboardingCompleted || hostBridge.platform.onboardingSteps().isEmpty()
    )
    val onboardingCompleted: StateFlow<Boolean> = _onboardingCompleted.asStateFlow()

    private val _localDaemonStatus = MutableStateFlow(LocalDaemonStatus())
    val localDaemonStatus: StateFlow<LocalDaemonStatus> = _localDaemonStatus.asStateFlow()

    private val _teams = MutableStateFlow<List<TeamSummary>>(emptyList())
    val teams: StateFlow<List<TeamSummary>> = _teams.asStateFlow()

    private val _selectedTeamId = MutableStateFlow<String?>(initialUiState.selectedTeamId)
    val selectedTeamId: StateFlow<String?> = _selectedTeamId.asStateFlow()

    private val _machinesByTeam = MutableStateFlow<Map<String, List<MachineSummary>>>(emptyMap())
    val machinesByTeam: StateFlow<Map<String, List<MachineSummary>>> = _machinesByTeam.asStateFlow()

    private val _pinnedSessionKeys = MutableStateFlow(initialUiState.pinnedSessionKeys.toSet())
    val pinnedSessionKeys: StateFlow<Set<String>> = _pinnedSessionKeys.asStateFlow()

    private val _sidebarWidthDp = MutableStateFlow(initialUiState.sidebarWidthDp.coerceIn(200f, 480f))
    val sidebarWidthDp: StateFlow<Float> = _sidebarWidthDp.asStateFlow()

    private val _sidebarCollapsed = MutableStateFlow(false)
    val sidebarCollapsed: StateFlow<Boolean> = _sidebarCollapsed.asStateFlow()

    // Desktop Multi-Pane Window State + Mobile Swipe/Overview State
    private val _leftTabs = MutableStateFlow<List<PaneTab>>(listOf(PaneTab.NewSession()))
    val leftTabs: StateFlow<List<PaneTab>> = _leftTabs.asStateFlow()

    private val _leftActiveTabId = MutableStateFlow("new-session")
    val leftActiveTabId: StateFlow<String> = _leftActiveTabId.asStateFlow()

    private val _rightTabs = MutableStateFlow<List<PaneTab>>(emptyList())
    val rightTabs: StateFlow<List<PaneTab>> = _rightTabs.asStateFlow()

    private val _rightActiveTabId = MutableStateFlow<String?>(null)
    val rightActiveTabId: StateFlow<String?> = _rightActiveTabId.asStateFlow()

    private val _activePaneSide = MutableStateFlow("left") // "left" | "right"
    val activePaneSide: StateFlow<String> = _activePaneSide.asStateFlow()

    private val _changesDrawerOpen = MutableStateFlow(false)
    val changesDrawerOpen: StateFlow<Boolean> = _changesDrawerOpen.asStateFlow()

    private val _mobileOverviewOpen = MutableStateFlow(false)
    val mobileOverviewOpen: StateFlow<Boolean> = _mobileOverviewOpen.asStateFlow()

    private val _mobileSidebarOpen = MutableStateFlow(false)
    val mobileSidebarOpen: StateFlow<Boolean> = _mobileSidebarOpen.asStateFlow()

    // Dialogs & Global Notices
    private val _showAddMachineDialog = MutableStateFlow(false)
    val showAddMachineDialog: StateFlow<Boolean> = _showAddMachineDialog.asStateFlow()

    private val _showCreateTeamDialog = MutableStateFlow(false)
    val showCreateTeamDialog: StateFlow<Boolean> = _showCreateTeamDialog.asStateFlow()

    private val _showReauthDialog = MutableStateFlow(false)
    val showReauthDialog: StateFlow<Boolean> = _showReauthDialog.asStateFlow()

    private val _teamMembers = MutableStateFlow<List<TeamMember>>(emptyList())
    val teamMembers: StateFlow<List<TeamMember>> = _teamMembers.asStateFlow()

    private val _teamBilling = MutableStateFlow<TeamBillingWire?>(null)
    val teamBilling: StateFlow<TeamBillingWire?> = _teamBilling.asStateFlow()

    private val _teamAiUsage = MutableStateFlow<TeamAiUsageWire?>(null)
    val teamAiUsage: StateFlow<TeamAiUsageWire?> = _teamAiUsage.asStateFlow()

    private val _searchResults = MutableStateFlow<List<SearchResultWire>>(emptyList())
    val searchResults: StateFlow<List<SearchResultWire>> = _searchResults.asStateFlow()

    private val _natResults = MutableStateFlow<List<NatProbeResultWire>>(emptyList())
    val natResults: StateFlow<List<NatProbeResultWire>> = _natResults.asStateFlow()

    private val _updateState = MutableStateFlow(UpdateStateWire())
    val updateState: StateFlow<UpdateStateWire> = _updateState.asStateFlow()

    private val _globalBannerError = MutableStateFlow<String?>(null)
    val globalBannerError: StateFlow<String?> = _globalBannerError.asStateFlow()

    private val runtimes = LinkedHashMap<String, MachineRuntime>()

    init {
        scope.launch {
            refreshLocalDaemonStatus()
            if (central.isSignedIn || hostBridge.platform.usesCookieSessionOnly) {
                runCatching {
                    val user = central.refreshStatus()
                    if (user != null) bootstrapTeamHierarchy()
                }
            }
        }
        scope.launch {
            central.events.collect { ev ->
                when (ev) {
                    CentralRealtimeEvent.AccountChanged -> {
                        if (central.isSignedIn) {
                            bootstrapTeamHierarchy()
                        } else {
                            clearAllRuntimes()
                        }
                    }
                    is CentralRealtimeEvent.ConnectionChanged -> {
                        if (ev.connected) bootstrapTeamHierarchy()
                    }
                    is CentralRealtimeEvent.MachinesChanged -> {
                        if (ev.teamId.isNotBlank()) refreshMachinesForTeam(ev.teamId)
                    }
                    is CentralRealtimeEvent.PresenceChanged -> {
                        val scopeKey = MachineScope(ev.teamId, ev.machineId).key
                        runtimes[scopeKey]?.updateOnline(ev.online)
                        val list = _machinesByTeam.value[ev.teamId]?.map {
                            if (it.id == ev.machineId) it.copy(online = ev.online) else it
                        }
                        if (list != null) {
                            _machinesByTeam.value = _machinesByTeam.value + (ev.teamId to list)
                        }
                    }
                    is CentralRealtimeEvent.CatalogChanged -> {
                        val scopeKey = MachineScope(ev.teamId, ev.machineId).key
                        runtimes[scopeKey]?.refreshCatalog()
                    }
                    else -> Unit
                }
            }
        }
    }

    // --- Persistence Helpers ---

    fun updatePreferences(transform: (AppearancePreferences) -> AppearancePreferences) {
        val next = transform(_preferences.value)
        _preferences.value = next
        runCatching {
            hostBridge.writePersistedState(
                "preferences.json",
                json.encodeToString(AppearancePreferences.serializer(), next),
            )
        }
        syncKeepAwake()
    }

    private fun saveUiState() {
        val snapshot = PersistedUiState(
            selectedTeamId = _selectedTeamId.value,
            pinnedSessionKeys = _pinnedSessionKeys.value.toList(),
            onboardingCompleted = _onboardingCompleted.value,
            sidebarWidthDp = _sidebarWidthDp.value,
        )
        runCatching {
            hostBridge.writePersistedState(
                "ui-state.json",
                json.encodeToString(PersistedUiState.serializer(), snapshot),
            )
        }
    }

    fun completeOnboarding() {
        _onboardingCompleted.value = true
        saveUiState()
    }

    fun setSidebarWidth(dp: Float) {
        _sidebarWidthDp.value = dp.coerceIn(200f, 480f)
        saveUiState()
    }

    fun toggleSidebarCollapsed() {
        _sidebarCollapsed.value = !_sidebarCollapsed.value
    }

    fun setMobileSidebarOpen(open: Boolean) {
        _mobileSidebarOpen.value = open
    }

    fun setMobileOverviewOpen(open: Boolean) {
        _mobileOverviewOpen.value = open
    }

    fun toggleChangesDrawer() {
        _changesDrawerOpen.value = !_changesDrawerOpen.value
    }

    fun setShowAddMachineDialog(show: Boolean) {
        _showAddMachineDialog.value = show
    }

    fun setShowCreateTeamDialog(show: Boolean) {
        _showCreateTeamDialog.value = show
    }

    fun setShowReauthDialog(show: Boolean) {
        _showReauthDialog.value = show
    }

    fun dismissBannerError() {
        _globalBannerError.value = null
    }

    // --- Auth Actions ---

    suspend fun signInWithPassword(serverUrl: String, email: String, password: String): AuthUser {
        central.setServerUrl(serverUrl)
        val user = central.signInWithPassword(email, password)
        bootstrapTeamHierarchy()
        return user
    }

    suspend fun signInWithBrowser(serverUrl: String): AuthUser {
        central.setServerUrl(serverUrl)
        val user = hostBridge.authenticateWithBrowser(central)
        bootstrapTeamHierarchy()
        return user
    }

    suspend fun registerAccount(serverUrl: String, name: String, email: String, password: String?): JsonObject {
        central.setServerUrl(serverUrl)
        return central.registerAccount(name, email, password)
    }

    suspend fun signOut() {
        central.logout()
        clearAllRuntimes()
    }

    // --- Teams, Machines & Runtimes ---

    suspend fun refreshLocalDaemonStatus() {
        if (!hostBridge.platform.supportsLocalDaemon) return
        _localDaemonStatus.value = hostBridge.queryLocalDaemonStatus(daemonDirOverride)
    }

    suspend fun bootstrapTeamHierarchy() {
        if (!central.isSignedIn) return
        try {
            val loadedTeams = central.listTeams()
            _teams.value = loadedTeams
            val currentTeamId = _selectedTeamId.value?.takeIf { id -> loadedTeams.any { it.id == id } }
                ?: loadedTeams.firstOrNull()?.id
            _selectedTeamId.value = currentTeamId
            saveUiState()
            if (currentTeamId != null) {
                refreshMachinesForTeam(currentTeamId)
                scope.launch { refreshTeamDetails(currentTeamId) }
            }
            refreshLocalDaemonStatus()
        } catch (err: CentralApiException) {
            if (err.code == "reauthentication_required") {
                _showReauthDialog.value = true
            } else {
                _globalBannerError.value = err.message
            }
        } catch (err: Throwable) {
            _globalBannerError.value = err.message
        }
    }

    fun selectTeam(teamId: String) {
        if (_selectedTeamId.value == teamId) return
        _selectedTeamId.value = teamId
        saveUiState()
        scope.launch {
            refreshMachinesForTeam(teamId)
            refreshTeamDetails(teamId)
        }
    }

    suspend fun createTeam(name: String): TeamSummary {
        val created = central.createTeam(name)
        _teams.value = central.listTeams()
        selectTeam(created.id)
        return created
    }

    suspend fun refreshMachinesForTeam(teamId: String) {
        val machines = central.listMachines(teamId)
        _machinesByTeam.value = _machinesByTeam.value + (teamId to machines)
        for (m in machines) {
            val rt = runtimeFor(MachineScope(teamId, m.id), m)
            rt.updateMachineSummary(m)
            scope.launch { rt.refreshCatalog() }
        }
        syncKeepAwake()
    }

    fun runtimeFor(machineScope: MachineScope, fallbackSummary: MachineSummary? = null): MachineRuntime {
        return runtimes.getOrPut(machineScope.key) {
            val summary = fallbackSummary
                ?: _machinesByTeam.value[machineScope.teamId]?.firstOrNull { it.id == machineScope.machineId }
                ?: MachineSummary(id = machineScope.machineId, teamId = machineScope.teamId, name = machineScope.machineId)
            MachineRuntime(
                scope = scope,
                machineScope = machineScope,
                initialMachine = summary,
                central = central,
                hostBridge = hostBridge,
                daemonDirOverride = daemonDirOverride,
            )
        }
    }

    fun currentTeamMachines(): List<MachineSummary> {
        val tid = _selectedTeamId.value ?: return emptyList()
        return _machinesByTeam.value[tid].orEmpty()
    }

    suspend fun enrollThisComputer(machineName: String? = null): MachineSummary {
        val tid = _selectedTeamId.value ?: error("Select or create a Team first")
        val enrolled = hostBridge.enrollLocalMachine(
            central = central,
            teamId = tid,
            machineName = machineName,
            daemonDirOverride = daemonDirOverride,
        )
        refreshLocalDaemonStatus()
        refreshMachinesForTeam(tid)
        return enrolled
    }

    suspend fun removeMachine(machineScope: MachineScope) {
        central.removeMachine(machineScope.teamId, machineScope.machineId)
        runtimes.remove(machineScope.key)?.close()
        refreshMachinesForTeam(machineScope.teamId)
    }

    suspend fun renameMachine(machineScope: MachineScope, name: String) {
        central.renameMachine(machineScope.teamId, machineScope.machineId, name)
        refreshMachinesForTeam(machineScope.teamId)
    }

    // --- Pins ---

    fun togglePinSession(sessionScope: SessionScope) {
        val next = _pinnedSessionKeys.value.toMutableSet()
        if (!next.add(sessionScope.key)) next.remove(sessionScope.key)
        _pinnedSessionKeys.value = next
        saveUiState()
    }

    // --- Window & Tab Navigation ---

    fun openTab(tab: PaneTab, inSplitRight: Boolean = false) {
        _mobileSidebarOpen.value = false
        _mobileOverviewOpen.value = false
        val useRight = inSplitRight || (_activePaneSide.value == "right" && _rightTabs.value.isNotEmpty())
        if (useRight) {
            val existing = _rightTabs.value
            val updated = if (existing.any { it.id == tab.id }) {
                existing.map { if (it.id == tab.id) tab else it }
            } else {
                existing + tab
            }
            _rightTabs.value = updated
            _rightActiveTabId.value = tab.id
            _activePaneSide.value = "right"
        } else {
            val existing = _leftTabs.value
            val updated = if (existing.any { it.id == tab.id }) {
                existing.map { if (it.id == tab.id) tab else it }
            } else {
                existing + tab
            }
            _leftTabs.value = updated
            _leftActiveTabId.value = tab.id
            _activePaneSide.value = "left"
        }
    }

    fun closeTab(tabId: String, fromRightPane: Boolean = false) {
        if (fromRightPane) {
            val rem = _rightTabs.value.filterNot { it.id == tabId }
            _rightTabs.value = rem
            if (_rightActiveTabId.value == tabId) {
                _rightActiveTabId.value = rem.lastOrNull()?.id
            }
            if (rem.isEmpty()) _activePaneSide.value = "left"
        } else {
            val rem = _leftTabs.value.filterNot { it.id == tabId }
            if (rem.isEmpty()) {
                val fallback = PaneTab.NewSession()
                _leftTabs.value = listOf(fallback)
                _leftActiveTabId.value = fallback.id
            } else {
                _leftTabs.value = rem
                if (_leftActiveTabId.value == tabId) {
                    _leftActiveTabId.value = rem.last().id
                }
            }
        }
    }

    fun focusTab(tabId: String, inRightPane: Boolean = false) {
        if (inRightPane) {
            _rightActiveTabId.value = tabId
            _activePaneSide.value = "right"
        } else {
            _leftActiveTabId.value = tabId
            _activePaneSide.value = "left"
        }
    }

    fun toggleSplitCurrentTab() {
        if (_rightTabs.value.isNotEmpty()) {
            val merged = (_leftTabs.value + _rightTabs.value).distinctBy { it.id }
            _leftTabs.value = merged
            _rightTabs.value = emptyList()
            _rightActiveTabId.value = null
            _activePaneSide.value = "left"
        } else {
            val active = _leftTabs.value.firstOrNull { it.id == _leftActiveTabId.value } ?: return
            _rightTabs.value = listOf(active)
            _rightActiveTabId.value = active.id
            _activePaneSide.value = "right"
        }
    }

    // --- Team Details, Search, NAT & Updates ---

    suspend fun refreshTeamDetails(teamId: String = _selectedTeamId.value.orEmpty()) {
        if (teamId.isBlank()) return
        runCatching { _teamMembers.value = central.listMembers(teamId) }
        runCatching { _teamBilling.value = central.billing(teamId) }
        runCatching { _teamAiUsage.value = central.aiUsage(teamId, period = "30d", timeZone = "UTC") }
    }

    suspend fun loadAiUsage(period: String, timeZone: String = "UTC") {
        val tid = _selectedTeamId.value ?: return
        _teamAiUsage.value = central.aiUsage(tid, period, timeZone)
    }

    suspend fun runSearch(query: String, kind: String = "all") {
        val tid = _selectedTeamId.value ?: return
        if (query.isBlank()) {
            _searchResults.value = emptyList()
            return
        }
        val page = central.search(tid, query.trim(), kind = kind)
        _searchResults.value = page.results
    }

    suspend fun runNatProbe(stunServers: List<String> = listOf("stun:stun.cloudflare.com:3478")) {
        _natResults.value = withContext(Dispatchers.Default) {
            stunServers.map { NativeRtcBridge.testNat(it) }
        }
    }

    suspend fun checkForUpdates() {
        _updateState.value = hostBridge.checkForUpdates()
    }

    private fun syncKeepAwake() {
        val anyWorking = runtimes.values.any { rt ->
            rt.catalog.value.sessions.any { it.isWorking }
        }
        hostBridge.setKeepAwake(_preferences.value.keepAwakeWhileWorking && anyWorking)
    }

    private fun clearAllRuntimes() {
        runtimes.values.forEach { it.close() }
        runtimes.clear()
        _teams.value = emptyList()
        _machinesByTeam.value = emptyMap()
        hostBridge.setKeepAwake(false)
    }

    fun dispose() {
        clearAllRuntimes()
        central.close()
        scope.cancel()
    }
}
