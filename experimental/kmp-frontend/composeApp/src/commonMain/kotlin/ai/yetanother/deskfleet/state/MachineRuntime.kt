package ai.yetanother.deskfleet.state

import ai.yetanother.deskfleet.platform.HostBridge
import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.transport.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

data class SystemChartSample(
    val timestampMs: Long,
    val cpuPercent: Float,
    val memoryPercent: Float,
)

/**
 * Strictly `(teamId, machineId)`-qualified runtime (`AGENTS.md` architecture rule):
 * - Owns one `MachineCatalog` (`workspaces`, `worktrees`, `sessions`, `archivedSessions`, `terminals`, `providers`).
 * - Negotiates the optimal data plane:
 *   1. Zero-hop Local Daemon IPC (`openLocalDaemonChannel`) when running on Desktop and enrolled locally.
 *   2. 4-lane `fixed4-v1` WebRTC Mux (`WebRtcMachinePeer.openMuxStream`) when `supportsFixed4Mux`.
 *   3. Single-purpose WebRTC DataChannel (`WebRtcMachinePeer.openSingleDataChannel`).
 * - Owns live `SessionLiveController`s, `TerminalLiveSession`s, `FilesChannelClient` + transfer queue,
 *   `DesktopSessionClient`, 2s `SystemStatus` ring buffer, `ScheduledTaskWire`s, and `McpServerConfigWire`s.
 */
class MachineRuntime(
    private val scope: CoroutineScope,
    val machineScope: MachineScope,
    initialMachine: MachineSummary,
    private val central: HttpCentralClient,
    private val hostBridge: HostBridge,
    private val daemonDirOverride: String? = null,
) {
    private val json = central.json
    val rtcPeer = WebRtcMachinePeer(scope, central, machineScope)
    val desktopSession = DesktopSessionClient(scope, central, machineScope)

    private val _machine = MutableStateFlow(initialMachine)
    val machine: StateFlow<MachineSummary> = _machine.asStateFlow()

    private val _catalog = MutableStateFlow(MachineCatalog())
    val catalog: StateFlow<MachineCatalog> = _catalog.asStateFlow()

    private val _desktopCapabilities = MutableStateFlow(DesktopCapabilities())
    val desktopCapabilities: StateFlow<DesktopCapabilities> = _desktopCapabilities.asStateFlow()

    private val _remoteFileListing = MutableStateFlow<FileListing?>(null)
    val remoteFileListing: StateFlow<FileListing?> = _remoteFileListing.asStateFlow()

    private val _localFileListing = MutableStateFlow<FileListing?>(null)
    val localFileListing: StateFlow<FileListing?> = _localFileListing.asStateFlow()

    private val _transfers = MutableStateFlow<List<FileTransferItem>>(emptyList())
    val transfers: StateFlow<List<FileTransferItem>> = _transfers.asStateFlow()

    private val _systemStatus = MutableStateFlow<SystemStatus?>(null)
    val systemStatus: StateFlow<SystemStatus?> = _systemStatus.asStateFlow()

    private val _systemHistory = MutableStateFlow<List<SystemChartSample>>(emptyList())
    val systemHistory: StateFlow<List<SystemChartSample>> = _systemHistory.asStateFlow()

    private val _schedules = MutableStateFlow<List<ScheduledTaskWire>>(emptyList())
    val schedules: StateFlow<List<ScheduledTaskWire>> = _schedules.asStateFlow()

    private val _mcpServers = MutableStateFlow<List<McpServerConfigWire>>(emptyList())
    val mcpServers: StateFlow<List<McpServerConfigWire>> = _mcpServers.asStateFlow()

    private val _transportBadge = MutableStateFlow("idle") // "idle" | "local-ipc" | "webrtc-mux" | "webrtc-dc"
    val transportBadge: StateFlow<String> = _transportBadge.asStateFlow()

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    private val agentMutex = Mutex()
    private var sharedAgentClient: AgentChannelClient? = null

    private val filesMutex = Mutex()
    private var sharedFilesClient: FilesChannelClient? = null

    private val sessionControllers = LinkedHashMap<String, SessionLiveController>()
    private val terminalSessions = LinkedHashMap<String, TerminalLiveSession>()
    private val transferJobs = LinkedHashMap<String, Job>()
    private var systemPollerJob: Job? = null

    fun updateMachineSummary(next: MachineSummary) {
        _machine.value = next
    }

    fun updateOnline(online: Boolean) {
        _machine.value = _machine.value.copy(online = online)
        if (!online) {
            sharedAgentClient?.close()
            sharedAgentClient = null
            sharedFilesClient?.close()
            sharedFilesClient = null
            rtcPeer.closeMux()
        }
    }

    // --- Transport Selection ---

    suspend fun openPurposeChannel(purpose: String, legacyLabel: String): DeskFleetChannel {
        // 1. Try zero-hop Local Daemon IPC on Desktop for "agent" / "terminal"
        if (hostBridge.platform.supportsLocalDaemon && (purpose == "agent" || purpose == "terminal")) {
            val localCh = runCatching {
                hostBridge.openLocalDaemonChannel(
                    scope = scope,
                    central = central,
                    machineScope = machineScope,
                    purpose = purpose,
                    daemonDirOverride = daemonDirOverride,
                )
            }.getOrNull()
            if (localCh != null) {
                _transportBadge.value = "local-ipc"
                return localCh
            }
        }
        // 2. Try `fixed4-v1` 4-lane WebRTC Mux when advertised by the daemon
        val muxPurpose = MuxPurpose.fromWire(purpose)
        if (muxPurpose != null && _machine.value.supportsFixed4Mux) {
            val muxCh = runCatching { rtcPeer.openMuxStream(muxPurpose) }.getOrNull()
            if (muxCh != null) {
                _transportBadge.value = "webrtc-mux"
                return muxCh
            }
        }
        // 3. Single-purpose WebRTC DataChannel
        val (dc, _) = rtcPeer.openSingleDataChannel(purpose = purpose, label = legacyLabel)
        _transportBadge.value = "webrtc-dc"
        return dc
    }

    suspend fun ensureAgentClient(): AgentChannelClient = agentMutex.withLock {
        sharedAgentClient?.let { return it }
        val ch = openPurposeChannel(purpose = "agent", legacyLabel = "deskfleet-acp")
        val client = AgentChannelClient(
            scope = scope,
            channel = ch,
            onNotification = { method, params ->
                sessionControllers.values.forEach { it.onAcpNotification(method, params) }
            },
            onServerRequest = { _, method, params ->
                if (method == "session/request_permission") {
                    val sid = params["sessionId"]?.jsonPrimitive?.contentOrNull
                    sessionControllers[sid]?.onAcpNotification(method, params)
                }
                JsonObject(emptyMap())
            },
            onDisconnected = {
                sharedAgentClient = null
            },
        )
        client.initializeIfNeeded()
        sharedAgentClient = client
        client
    }

    suspend fun ensureFilesClient(): FilesChannelClient = filesMutex.withLock {
        sharedFilesClient?.let { return it }
        val ch = openPurposeChannel(purpose = "files", legacyLabel = "deskfleet-files")
        val client = FilesChannelClient(scope = scope, channel = ch)
        sharedFilesClient = client
        client
    }

    // --- Catalog, Workspaces & Sessions ---

    suspend fun refreshCatalog() {
        try {
            val catObj = runCatching {
                central.fetchCatalogRaw(machineScope.teamId, machineScope.machineId)
            }.getOrDefault(JsonObject(emptyMap()))
            val liveSnap = if (_machine.value.online) {
                runCatching {
                    central.rpc(machineScope.teamId, machineScope.machineId, "catalogList").jsonObject
                }.getOrNull()
            } else null
            val snap = liveSnap ?: (catObj["snapshot"] as? JsonObject) ?: catObj
            val (workspaces, worktrees) = parseCatalogWorkspacesAndWorktrees(snap)
            val providersObj = (catObj["providers"] as? JsonObject)?.get("providers") as? JsonArray
                ?: (snap["providers"] as? JsonArray)
            val providers = providersObj.orEmpty().mapNotNull { p ->
                runCatching { json.decodeFromJsonElement(ProviderSummary.serializer(), p) }.getOrNull()
            }.ifEmpty {
                listOf(
                    ProviderSummary(id = "codex", name = "Codex", installed = true, authenticated = true),
                    ProviderSummary(id = "claude-code", name = "Claude Code", installed = true, authenticated = true),
                    ProviderSummary(id = "gemini", name = "Gemini CLI", installed = true, authenticated = true),
                )
            }

            val rawSessions = runCatching {
                central.fetchSessionsRaw(machineScope.teamId, machineScope.machineId)
            }.getOrDefault(emptyList())
            val parsedSessions = rawSessions.mapNotNull { so -> parseSessionSummaryObject(so) }
            val activeSessions = parsedSessions.filterNot { it.archived }
            val archivedSessions = parsedSessions.filter { it.archived }

            val terminals = if (_machine.value.online) {
                runCatching {
                    val res = central.rpc(machineScope.teamId, machineScope.machineId, "terminalList")
                    (res as? JsonArray).orEmpty().mapNotNull { t ->
                        val to = t as? JsonObject ?: return@mapNotNull null
                        TerminalSummary(
                            id = to["id"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                            title = to["title"]?.jsonPrimitive?.content ?: "Terminal",
                            cwd = to["cwd"]?.jsonPrimitive?.content.orEmpty(),
                            cols = to["cols"]?.jsonPrimitive?.intOrNull ?: 120,
                            rows = to["rows"]?.jsonPrimitive?.intOrNull ?: 34,
                            worktreeId = to["worktreeId"]?.jsonPrimitive?.contentOrNull,
                            exited = to["status"]?.jsonPrimitive?.contentOrNull == "exited",
                            exitCode = to["exitCode"]?.jsonPrimitive?.intOrNull,
                        )
                    }
                }.getOrDefault(_catalog.value.terminals)
            } else {
                _catalog.value.terminals
            }

            _catalog.value = MachineCatalog(
                revision = _catalog.value.revision + 1,
                workspaces = workspaces,
                worktrees = worktrees,
                sessions = activeSessions,
                archivedSessions = archivedSessions,
                terminals = terminals,
                providers = providers,
                hostHomeDirectory = snap["homeDirectory"]?.jsonPrimitive?.content.orEmpty(),
            )
        } catch (err: Throwable) {
            _lastError.value = err.message
        }
    }

    suspend fun createWorkspace(name: String, directories: List<String>): WorkspaceSummary {
        val res = central.rpc(
            machineScope.teamId,
            machineScope.machineId,
            "workspaceCreate",
            buildJsonObject {
                put("name", name.trim())
                put("directories", buildJsonArray {
                    directories.filter { it.isNotBlank() }.distinct().forEach { path ->
                        add(buildJsonObject { put("path", path.trim()) })
                    }
                })
            },
        ).jsonObject
        refreshCatalog()
        return WorkspaceSummary(
            id = res["id"]?.jsonPrimitive?.content.orEmpty(),
            name = res["name"]?.jsonPrimitive?.content ?: name.trim(),
            directories = directories,
        )
    }

    suspend fun updateWorkspace(workspaceId: String, name: String, directories: List<String>) {
        central.rpc(
            machineScope.teamId,
            machineScope.machineId,
            "workspaceUpdate",
            buildJsonObject {
                put("workspaceId", workspaceId)
                put("name", name.trim())
                put("directories", buildJsonArray {
                    directories.filter { it.isNotBlank() }.distinct().forEach { path ->
                        add(buildJsonObject { put("path", path.trim()) })
                    }
                })
            },
        )
        refreshCatalog()
    }

    suspend fun deleteWorkspace(workspaceId: String) {
        central.rpc(
            machineScope.teamId,
            machineScope.machineId,
            "workspaceDelete",
            buildJsonObject { put("workspaceId", workspaceId) },
        )
        refreshCatalog()
    }

    // --- Agent Session Lifecycle ---

    fun getOrCreateSessionController(sessionId: String): SessionLiveController {
        val scoped = SessionScope(machineScope.teamId, machineScope.machineId, sessionId)
        return sessionControllers.getOrPut(sessionId) {
            SessionLiveController(
                scope = scope,
                sessionScope = scoped,
                central = central,
                hostBridge = hostBridge,
                obtainAgentClient = { ensureAgentClient() },
            )
        }
    }

    suspend fun createAgentSession(
        provider: String,
        context: String = "worktree",
        workspaceId: String? = null,
        title: String? = null,
        cwd: String? = null,
        baseBranch: String? = null,
        model: String? = null,
        reasoningEffort: String? = null,
        mode: String? = null,
        initialPrompt: String? = null,
    ): String {
        val client = ensureAgentClient()
        val snap = client.createSession(
            operationId = randomOperationId("create-session"),
            provider = provider,
            context = context,
            workspaceId = workspaceId,
            title = title,
            cwd = cwd,
            baseBranch = baseBranch,
            model = model,
            reasoningEffort = reasoningEffort,
            mode = mode,
        )
        val sessionObj = (snap["session"] as? JsonObject) ?: snap
        val sessionId = sessionObj["id"]?.jsonPrimitive?.content ?: error("Session created without id")
        refreshCatalog()
        val controller = getOrCreateSessionController(sessionId)
        controller.hydrateAndSubscribe(force = true)
        if (!initialPrompt.isNullOrBlank()) {
            controller.sendPrompt(initialPrompt)
        }
        return sessionId
    }

    suspend fun renameSession(sessionId: String, title: String) {
        ensureAgentClient().renameSession(sessionId, randomOperationId("rename"), title.trim())
        refreshCatalog()
    }

    suspend fun archiveSession(sessionId: String) {
        ensureAgentClient().archiveSession(sessionId, randomOperationId("archive"))
        refreshCatalog()
    }

    suspend fun restoreSession(sessionId: String) {
        ensureAgentClient().restoreSession(sessionId, randomOperationId("restore"))
        refreshCatalog()
    }

    suspend fun deleteArchivedSession(sessionId: String) {
        runCatching { ensureAgentClient().deleteSession(sessionId, randomOperationId("delete")) }
            .onFailure {
                central.rpc(
                    machineScope.teamId,
                    machineScope.machineId,
                    "workspaceSessionDestroy",
                    buildJsonObject { put("sessionId", sessionId) },
                )
            }
        sessionControllers.remove(sessionId)?.onLeave()
        refreshCatalog()
    }

    suspend fun forkSession(sessionId: String, context: String = "worktree", title: String? = null): String {
        val snap = ensureAgentClient().forkSession(sessionId, randomOperationId("fork"), context, title)
        val forkedId = (snap["session"] as? JsonObject)?.get("id")?.jsonPrimitive?.content
            ?: error("Forked session missing ID")
        refreshCatalog()
        return forkedId
    }

    suspend fun configureSession(sessionId: String, model: String?, reasoningEffort: String?, mode: String?) {
        ensureAgentClient().configureSession(sessionId, randomOperationId("cfg"), model, reasoningEffort, mode)
        refreshCatalog()
    }

    // --- Interactive PTY Terminals ---

    suspend fun dialNewTerminal(
        cwd: String? = null,
        worktreeId: String? = null,
        cols: Int = 120,
        rows: Int = 34,
    ): TerminalLiveSession {
        val terminalId = randomOperationId("term")
        val res = central.rpc(
            machineScope.teamId,
            machineScope.machineId,
            "terminalDial",
            buildJsonObject {
                put("mode", "create")
                put("terminalId", terminalId)
                put("cols", cols)
                put("rows", rows)
                if (!cwd.isNullOrBlank()) put("cwd", cwd)
                if (!worktreeId.isNullOrBlank()) put("worktreeId", worktreeId)
            },
        ).jsonObject
        val summary = TerminalSummary(
            id = res["id"]?.jsonPrimitive?.content ?: terminalId,
            title = res["title"]?.jsonPrimitive?.content ?: "Terminal",
            cwd = res["cwd"]?.jsonPrimitive?.content ?: cwd.orEmpty(),
            cols = res["cols"]?.jsonPrimitive?.intOrNull ?: cols,
            rows = res["rows"]?.jsonPrimitive?.intOrNull ?: rows,
            worktreeId = worktreeId,
        )
        refreshCatalog()
        return attachTerminalSession(summary)
    }

    suspend fun attachTerminalSession(summary: TerminalSummary): TerminalLiveSession {
        val live = terminalSessions.getOrPut(summary.id) {
            TerminalLiveSession(
                scope = scope,
                machineScope = machineScope,
                terminalId = summary.id,
                initialSummary = summary,
                obtainChannel = { openPurposeChannel("terminal", "deskfleet-terminal") },
            )
        }
        live.connectAndAttach()
        return live
    }

    fun getTerminalSession(terminalId: String): TerminalLiveSession? = terminalSessions[terminalId]

    suspend fun hangupTerminal(terminalId: String) {
        terminalSessions.remove(terminalId)?.close()
        runCatching {
            central.rpc(
                machineScope.teamId,
                machineScope.machineId,
                "terminalHangup",
                buildJsonObject { put("terminalId", terminalId) },
            )
        }
        refreshCatalog()
    }

    // --- Two-Pane File Browser & Transfer Queue ---

    suspend fun browseLocal(path: String? = null) {
        _localFileListing.value = hostBridge.listLocalFiles(path)
    }

    suspend fun browseRemote(path: String? = null) {
        val listing = ensureFilesClient().list(path)
        _remoteFileListing.value = listing
    }

    fun enqueueUpload(localEntry: FileEntry, remoteDirectory: String, conflict: FileConflictPolicy = FileConflictPolicy.RENAME) {
        val id = randomOperationId("xfer-up")
        val item = FileTransferItem(
            id = id,
            name = localEntry.name,
            kind = localEntry.kind,
            source = FileLocation(FileTarget.Local(), localEntry.path),
            destination = FileLocation(
                FileTarget.Machine(machineScope.teamId, machineScope.machineId, _machine.value.name),
                remoteDirectory,
            ),
            state = "queued",
            totalBytes = localEntry.size,
        )
        _transfers.value = listOf(item) + _transfers.value
        runTransferJob(item, isUpload = true, conflict = conflict)
    }

    fun enqueueDownload(remoteEntry: FileEntry, localDirectory: String, conflict: FileConflictPolicy = FileConflictPolicy.RENAME) {
        val id = randomOperationId("xfer-down")
        val item = FileTransferItem(
            id = id,
            name = remoteEntry.name,
            kind = remoteEntry.kind,
            source = FileLocation(
                FileTarget.Machine(machineScope.teamId, machineScope.machineId, _machine.value.name),
                remoteEntry.path,
            ),
            destination = FileLocation(FileTarget.Local(), localDirectory),
            state = "queued",
            totalBytes = remoteEntry.size,
        )
        _transfers.value = listOf(item) + _transfers.value
        runTransferJob(item, isUpload = false, conflict = conflict)
    }

    private fun runTransferJob(item: FileTransferItem, isUpload: Boolean, conflict: FileConflictPolicy) {
        val job = scope.launch {
            updateTransfer(item.id) { it.copy(state = "transferring", error = null) }
            try {
                val client = ensureFilesClient()
                if (isUpload) {
                    val bytes = hostBridge.readLocalFileBytes(item.source.path)
                    client.uploadFileBytes(
                        destinationDirectory = item.destination.path,
                        fileName = item.name,
                        bytes = bytes,
                        conflict = conflict,
                        onProgress = { transferred, total ->
                            updateTransfer(item.id) { it.copy(transferredBytes = transferred, totalBytes = total) }
                        },
                    )
                    browseRemote(item.destination.path)
                } else {
                    val bytes = client.readAllBytes(
                        remotePath = item.source.path,
                        totalSizeHint = item.totalBytes,
                        onProgress = { transferred, total ->
                            updateTransfer(item.id) { it.copy(transferredBytes = transferred, totalBytes = total) }
                        },
                    )
                    hostBridge.writeLocalFileBytes(
                        directory = item.destination.path,
                        fileName = item.name,
                        bytes = bytes,
                        conflict = conflict,
                    )
                    browseLocal(item.destination.path)
                }
                updateTransfer(item.id) { it.copy(state = "completed", transferredBytes = it.totalBytes ?: it.transferredBytes) }
            } catch (_: CancellationException) {
                updateTransfer(item.id) { it.copy(state = "cancelled") }
            } catch (err: Throwable) {
                val msg = err.message ?: "Transfer failed"
                val st = if (msg.contains("exists", ignoreCase = true) || msg.contains("conflict", ignoreCase = true)) {
                    "conflict"
                } else {
                    "failed"
                }
                updateTransfer(item.id) { it.copy(state = st, error = msg) }
            } finally {
                transferJobs.remove(item.id)
            }
        }
        transferJobs[item.id] = job
    }

    fun cancelTransfer(transferId: String) {
        transferJobs.remove(transferId)?.cancel()
        updateTransfer(transferId) { it.copy(state = "cancelled") }
    }

    fun retryTransfer(transferId: String, conflict: FileConflictPolicy = FileConflictPolicy.REPLACE) {
        val item = _transfers.value.firstOrNull { it.id == transferId } ?: return
        val isUpload = item.source.target is FileTarget.Local
        runTransferJob(item, isUpload = isUpload, conflict = conflict)
    }

    private fun updateTransfer(id: String, fn: (FileTransferItem) -> FileTransferItem) {
        _transfers.value = _transfers.value.map { if (it.id == id) fn(it) else it }
    }

    // --- Remote Desktop ---

    suspend fun refreshDesktopCapabilities() {
        runCatching {
            val res = central.rpc(machineScope.teamId, machineScope.machineId, "capabilities").jsonObject
            val displays = (res["displays"] as? JsonArray).orEmpty().mapIndexedNotNull { idx, d ->
                val dobj = d as? JsonObject ?: return@mapIndexedNotNull null
                val did = dobj["id"]?.jsonPrimitive?.content ?: idx.toString()
                DesktopDisplayInfo(
                    id = did,
                    name = "Display ${idx + 1}",
                    width = dobj["width"]?.jsonPrimitive?.intOrNull ?: 1920,
                    height = dobj["height"]?.jsonPrimitive?.intOrNull ?: 1080,
                    primary = idx == 0,
                )
            }
            _desktopCapabilities.value = DesktopCapabilities(
                available = displays.isNotEmpty(),
                canControl = true,
                secureAttention = res["secureAttention"]?.jsonPrimitive?.booleanOrNull == true,
                displays = displays,
            )
        }
    }

    suspend fun startEmbeddedDesktop(displayId: String? = null, control: Boolean = true) {
        refreshDesktopCapabilities()
        desktopSession.startEmbedded(rtcPeer, displayId = displayId, control = control)
    }

    suspend fun launchNativeViewer(control: Boolean = true): Boolean =
        hostBridge.launchNativeDesktopViewer(
            scope = scope,
            central = central,
            machineScope = machineScope,
            title = "${_machine.value.name} — DeskFleet",
            control = control,
        )

    // --- System Status (2s live poller) ---

    fun startSystemStatusPolling() {
        if (systemPollerJob?.isActive == true) return
        systemPollerJob = scope.launch {
            while (isActive) {
                runCatching {
                    val raw = central.rpc(machineScope.teamId, machineScope.machineId, "systemStatus")
                    val parsed = parseSystemStatusPayload(json, raw.jsonObject, _machine.value)
                    _systemStatus.value = parsed
                    val memPct = if (parsed.memoryTotalBytes > 0) {
                        ((parsed.memoryUsedBytes.toDouble() / parsed.memoryTotalBytes.toDouble()) * 100.0).toFloat()
                    } else 0f
                    val sample = SystemChartSample(
                        timestampMs = currentTimeMillis(),
                        cpuPercent = parsed.cpuUsagePercent.toFloat().coerceIn(0f, 100f),
                        memoryPercent = memPct.coerceIn(0f, 100f),
                    )
                    _systemHistory.value = (_systemHistory.value + sample).takeLast(60)
                }
                delay(2_000L)
            }
        }
    }

    fun stopSystemStatusPolling() {
        systemPollerJob?.cancel()
        systemPollerJob = null
    }

    // --- Schedules & MCP Servers ---

    suspend fun refreshSchedules() {
        val list = runCatching {
            val res = central.rpc(machineScope.teamId, machineScope.machineId, "scheduleList")
            json.decodeFromJsonElement<List<ScheduledTaskWire>>(res)
        }.getOrElse {
            runCatching { central.scheduleSnapshot(machineScope.teamId, machineScope.machineId) }.getOrDefault(emptyList())
        }
        _schedules.value = list
    }

    suspend fun createSchedule(input: ScheduleInputWire): ScheduledTaskWire {
        val res = central.rpc(
            machineScope.teamId,
            machineScope.machineId,
            "scheduleCreate",
            buildJsonObject {
                put("schedule", json.encodeToJsonElement(ScheduleInputWire.serializer(), input))
            },
        )
        val created = json.decodeFromJsonElement(ScheduledTaskWire.serializer(), res)
        refreshSchedules()
        return created
    }

    suspend fun updateSchedule(scheduleId: String, changes: JsonObject) {
        central.rpc(
            machineScope.teamId,
            machineScope.machineId,
            "scheduleUpdate",
            buildJsonObject {
                put("scheduleId", scheduleId)
                put("changes", changes)
            },
        )
        refreshSchedules()
    }

    suspend fun deleteSchedule(scheduleId: String) {
        central.rpc(
            machineScope.teamId,
            machineScope.machineId,
            "scheduleDelete",
            buildJsonObject { put("scheduleId", scheduleId) },
        )
        refreshSchedules()
    }

    suspend fun runScheduleNow(scheduleId: String) {
        central.rpc(
            machineScope.teamId,
            machineScope.machineId,
            "scheduleRun",
            buildJsonObject { put("scheduleId", scheduleId) },
        )
        refreshSchedules()
    }

    suspend fun refreshMcpServers() {
        runCatching {
            val res = central.rpc(machineScope.teamId, machineScope.machineId, "mcpServerList")
            val snap = json.decodeFromJsonElement(McpServerSnapshotWire.serializer(), res)
            _mcpServers.value = snap.servers
        }
    }

    suspend fun upsertMcpServer(server: McpServerConfigWire) {
        val inputJson = buildMcpServerWireInput(server)
        if (server.id.isBlank()) {
            central.rpc(
                machineScope.teamId,
                machineScope.machineId,
                "mcpServerCreate",
                buildJsonObject { put("server", inputJson) },
            )
        } else {
            central.rpc(
                machineScope.teamId,
                machineScope.machineId,
                "mcpServerUpdate",
                buildJsonObject {
                    put("serverId", server.id)
                    put("changes", inputJson)
                },
            )
        }
        refreshMcpServers()
    }

    suspend fun removeMcpServer(serverId: String) {
        central.rpc(
            machineScope.teamId,
            machineScope.machineId,
            "mcpServerRemove",
            buildJsonObject { put("serverId", serverId) },
        )
        refreshMcpServers()
    }

    fun close() {
        stopSystemStatusPolling()
        desktopSession.stop()
        terminalSessions.values.forEach { it.close() }
        terminalSessions.clear()
        sessionControllers.values.forEach { it.onLeave() }
        sessionControllers.clear()
        sharedAgentClient?.close()
        sharedAgentClient = null
        sharedFilesClient?.close()
        sharedFilesClient = null
        rtcPeer.closeMux()
    }
}
