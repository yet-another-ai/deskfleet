package ai.yetanother.deskfleet.state

import ai.yetanother.deskfleet.platform.HostBridge
import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.terminal.TerminalSnapshot
import ai.yetanother.deskfleet.terminal.VtTerminalEmulator
import ai.yetanother.deskfleet.transport.*
import kotlin.random.Random
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.*

internal fun randomOperationId(prefix: String = "op"): String {
    val rand = Random.nextLong().toULong().toString(16)
    return "$prefix-${currentTimeMillis()}-$rand"
}

/**
 * Live controller for one `(teamId, machineId, sessionId)` Agent Session:
 * - Hydrates immediately from Central `/sessions/{id}` + `/events` so offline/historical transcripts render right away.
 * - Subscribes over the machine's ACP `AgentChannelClient` (`_deskfleet/session/subscribe` + `attend`) when online.
 * - Supports YOLO auto-permission approval, prompt submission/steering, backlog withdrawal, git status/diff, and `@`/`$`/`/` completions.
 */
class SessionLiveController(
    private val scope: CoroutineScope,
    val sessionScope: SessionScope,
    private val central: HttpCentralClient,
    private val hostBridge: HostBridge,
    private val obtainAgentClient: suspend () -> AgentChannelClient,
) {
    private val projector = ConversationProjector()

    private val _conversation = MutableStateFlow(ProjectedConversation())
    val conversation: StateFlow<ProjectedConversation> = _conversation.asStateFlow()

    private val _gitStatus = MutableStateFlow(GitStatusSnapshot())
    val gitStatus: StateFlow<GitStatusSnapshot> = _gitStatus.asStateFlow()

    private val _completions = MutableStateFlow<List<ComposerCompletionItem>>(emptyList())
    val completions: StateFlow<List<ComposerCompletionItem>> = _completions.asStateFlow()

    private val _yoloEnabled = MutableStateFlow(false)
    val yoloEnabled: StateFlow<Boolean> = _yoloEnabled.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _liveConnected = MutableStateFlow(false)
    val liveConnected: StateFlow<Boolean> = _liveConnected.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private var activeTurnId: String? = null
    private var hydratedOnce = false

    suspend fun hydrateAndSubscribe(force: Boolean = false) {
        if (hydratedOnce && !force) return
        _loading.value = true
        _error.value = null
        try {
            // 1. Hydrate recorded snapshot + events from Central REST so even offline machines show full history.
            runCatching {
                val snap = central.fetchSessionSnapshotRaw(
                    sessionScope.teamId,
                    sessionScope.machineId,
                    sessionScope.sessionId,
                )
                projector.applyCentralSnapshot(snap)
                extractActiveTurnId(snap)
                val evPage = central.fetchSessionEventsRaw(
                    sessionScope.teamId,
                    sessionScope.machineId,
                    sessionScope.sessionId,
                    after = "0",
                    limit = 500,
                )
                val events = evPage["events"] as? JsonArray ?: JsonArray(emptyList())
                val nextSeq = evPage["lastEventSeq"]?.jsonPrimitive?.contentOrNull
                projector.applyRecordedEvents(events, nextSeq)
                _conversation.value = projector.snapshot()
            }

            // 2. Attach live ACP subscription over Local Daemon IPC / fixed4-v1 Mux / DataChannel.
            runCatching {
                val client = obtainAgentClient()
                val liveSnap = client.subscribeSession(sessionScope.sessionId)
                projector.applyCentralSnapshot(liveSnap)
                extractActiveTurnId(liveSnap)
                val catchup = client.sessionHistory(sessionScope.sessionId, afterSeq = projector.snapshot().lastSeq)
                if (catchup.isNotEmpty()) {
                    projector.applyRecordedEvents(catchup)
                }
                client.attendSession(sessionScope.sessionId)
                _liveConnected.value = true
                _conversation.value = projector.snapshot()
                autoApproveIfYolo()
            }.onFailure {
                _liveConnected.value = false
            }
            hydratedOnce = true
            scope.launch { refreshGitStatus(force = false) }
        } catch (err: Throwable) {
            _error.value = err.message
        } finally {
            _loading.value = false
        }
    }

    private fun extractActiveTurnId(snapWrapper: JsonObject) {
        val snap = (snapWrapper["snapshot"] as? JsonObject) ?: snapWrapper
        val turns = snap["turns"] as? JsonArray ?: return
        activeTurnId = turns.lastOrNull { t ->
            val st = (t as? JsonObject)?.get("state")?.jsonPrimitive?.contentOrNull
            st == "starting" || st == "running"
        }?.let { (it as? JsonObject)?.get("id")?.jsonPrimitive?.contentOrNull }
    }

    fun onAcpNotification(method: String, params: JsonObject) {
        val sid = params["sessionId"]?.jsonPrimitive?.contentOrNull
            ?: (params["session"] as? JsonObject)?.get("id")?.jsonPrimitive?.contentOrNull
        if (sid != null && sid != sessionScope.sessionId) return
        projector.applyAcpNotification(method, params)
        val snap = projector.snapshot()
        _conversation.value = snap
        if (!snap.isStreaming) {
            scope.launch { refreshGitStatus(force = false) }
        }
        if (_yoloEnabled.value && snap.permissions.isNotEmpty()) {
            scope.launch { autoApproveIfYolo() }
        }
    }

    fun setYolo(enabled: Boolean) {
        _yoloEnabled.value = enabled
        if (enabled) {
            scope.launch { autoApproveIfYolo() }
        }
    }

    private suspend fun autoApproveIfYolo() {
        if (!_yoloEnabled.value) return
        val perms = _conversation.value.permissions
        for (perm in perms) {
            val allowOpt = perm.options.firstOrNull { it.kind == "allow_once" || it.kind == "allow_always" }
                ?: perm.options.firstOrNull()
                ?: continue
            runCatching { respondPermission(perm.requestId, allowOpt.optionId) }
        }
    }

    suspend fun sendPrompt(
        text: String,
        attachments: List<PromptAttachment> = emptyList(),
        steer: Boolean = false,
    ) {
        val trimmed = text.trim()
        if (trimmed.isEmpty() && attachments.isEmpty()) return
        _error.value = null
        val blocks = buildList {
            if (trimmed.isNotEmpty()) {
                add(buildJsonObject {
                    put("type", "text")
                    put("text", trimmed)
                })
            }
            for (att in attachments) {
                add(buildJsonObject {
                    put("type", "resource_link")
                    put("name", att.name)
                    put("uri", att.uri.ifBlank { "file://${att.path}" })
                    put("mimeType", att.mimeType)
                })
            }
        }
        projector.addOptimisticUserMessage(trimmed)
        _conversation.value = projector.snapshot()
        try {
            val client = obtainAgentClient()
            val receipt = client.submitPrompt(
                sessionId = sessionScope.sessionId,
                operationId = randomOperationId("prompt"),
                blocks = blocks,
                steer = steer,
                turnId = if (steer) activeTurnId else null,
            )
            (receipt as? JsonObject)?.get("turnId")?.jsonPrimitive?.contentOrNull?.let { activeTurnId = it }
        } catch (err: Throwable) {
            _error.value = err.message ?: "Failed to send prompt"
            throw err
        }
    }

    suspend fun cancelActiveTurn() {
        val client = obtainAgentClient()
        val tid = activeTurnId
        if (!tid.isNullOrBlank()) {
            runCatching { client.cancelTurn(sessionScope.sessionId, randomOperationId("cancel"), tid) }
                .onFailure { client.stopSession(sessionScope.sessionId, randomOperationId("stop")) }
        } else {
            client.stopSession(sessionScope.sessionId, randomOperationId("stop"))
        }
    }

    suspend fun withdrawBacklogItem(inputId: String) {
        val client = obtainAgentClient()
        client.withdrawQueuedInput(sessionScope.sessionId, randomOperationId("withdraw"), inputId)
    }

    suspend fun respondPermission(permissionId: String, optionId: String) {
        projector.resolvePermissionLocally(permissionId)
        _conversation.value = projector.snapshot()
        val client = obtainAgentClient()
        client.respondPermission(sessionScope.sessionId, randomOperationId("perm"), permissionId, optionId)
    }

    suspend fun respondElicitation(elicitationId: String, action: String, values: Map<String, String> = emptyMap()) {
        projector.resolveElicitationLocally(elicitationId)
        _conversation.value = projector.snapshot()
        val contentObj = if (values.isEmpty()) null else buildJsonObject {
            values.forEach { (k, v) -> put(k, v) }
        }
        val client = obtainAgentClient()
        client.respondElicitation(sessionScope.sessionId, randomOperationId("elic"), elicitationId, action, contentObj)
    }

    suspend fun refreshGitStatus(force: Boolean = true) {
        runCatching {
            val client = obtainAgentClient()
            val res = client.queryGitStatus(sessionScope.sessionId, force = force) as? JsonObject ?: return
            val branch = res["branch"]?.jsonPrimitive?.contentOrNull
            val ahead = res["ahead"]?.jsonPrimitive?.intOrNull ?: 0
            val behind = res["behind"]?.jsonPrimitive?.intOrNull ?: 0
            val filesArr = (res["files"] as? JsonArray) ?: (res["changes"] as? JsonArray) ?: JsonArray(emptyList())
            val parsedFiles = filesArr.mapNotNull { fEl ->
                val fo = fEl as? JsonObject ?: return@mapNotNull null
                GitChangedFile(
                    path = fo["path"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                    oldPath = fo["oldPath"]?.jsonPrimitive?.contentOrNull,
                    status = fo["status"]?.jsonPrimitive?.content ?: "modified",
                    staged = fo["staged"]?.jsonPrimitive?.booleanOrNull ?: false,
                    additions = fo["additions"]?.jsonPrimitive?.intOrNull ?: 0,
                    deletions = fo["deletions"]?.jsonPrimitive?.intOrNull ?: 0,
                    patch = fo["patch"]?.jsonPrimitive?.content.orEmpty(),
                    repoRoot = fo["repository"]?.jsonPrimitive?.content.orEmpty(),
                )
            }
            _gitStatus.value = GitStatusSnapshot(
                branch = branch,
                ahead = ahead,
                behind = behind,
                files = parsedFiles,
                clean = parsedFiles.isEmpty(),
            )
        }
    }

    suspend fun loadFileDiff(file: GitChangedFile): String {
        if (file.patch.isNotBlank()) return file.patch
        val client = obtainAgentClient()
        val res = client.queryGitDiff(sessionScope.sessionId, file.repoRoot, file.path) as? JsonObject
        val patch = res?.get("patch")?.jsonPrimitive?.content
            ?: res?.get("diff")?.jsonPrimitive?.content
            ?: ""
        if (patch.isNotBlank()) {
            _gitStatus.value = _gitStatus.value.copy(
                files = _gitStatus.value.files.map {
                    if (it.path == file.path && it.repoRoot == file.repoRoot) it.copy(patch = patch) else it
                }
            )
        }
        return patch
    }

    suspend fun updateCompletions(trigger: String, query: String) {
        runCatching {
            val client = obtainAgentClient()
            val res = client.queryCompletions(sessionScope.sessionId, query, trigger)
            val arr = (res as? JsonObject)?.get("items") as? JsonArray
                ?: (res as? JsonObject)?.get("references") as? JsonArray
                ?: (res as? JsonArray)
                ?: JsonArray(emptyList())
            _completions.value = arr.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                val lbl = o["label"]?.jsonPrimitive?.content ?: o["name"]?.jsonPrimitive?.content ?: return@mapNotNull null
                ComposerCompletionItem(
                    kind = o["kind"]?.jsonPrimitive?.content ?: "file",
                    trigger = trigger,
                    label = lbl,
                    insertText = o["insertText"]?.jsonPrimitive?.content ?: "$trigger$lbl ",
                    detail = o["detail"]?.jsonPrimitive?.contentOrNull ?: o["path"]?.jsonPrimitive?.contentOrNull,
                    uri = o["uri"]?.jsonPrimitive?.contentOrNull,
                )
            }
        }.onFailure {
            _completions.value = emptyList()
        }
    }

    fun clearCompletions() {
        _completions.value = emptyList()
    }

    fun onLeave() {
        if (_liveConnected.value) {
            scope.launch {
                runCatching { obtainAgentClient().leaveSession(sessionScope.sessionId) }
            }
        }
    }
}

/**
 * Sticky modifier state (`OFF` -> `ONCE` -> `LOCKED` -> `OFF`) matching `packages/components/src/components/terminal/TerminalKeypad.vue`.
 */
enum class StickyModifierState {
    OFF,
    ONCE,
    LOCKED,
    ;

    fun next(): StickyModifierState = when (this) {
        OFF -> ONCE
        ONCE -> LOCKED
        LOCKED -> OFF
    }
}

/**
 * Live interactive PTY terminal session bound to `(MachineScope, terminalId)`.
 */
class TerminalLiveSession(
    private val scope: CoroutineScope,
    val machineScope: MachineScope,
    val terminalId: String,
    initialSummary: TerminalSummary,
    private val obtainChannel: suspend () -> DeskFleetChannel,
) {
    val emulator = VtTerminalEmulator(
        initialCols = initialSummary.cols.coerceAtLeast(20),
        initialRows = initialSummary.rows.coerceAtLeast(6),
    )
    val snapshot: StateFlow<TerminalSnapshot> = emulator.snapshot

    private val _summary = MutableStateFlow(initialSummary)
    val summary: StateFlow<TerminalSummary> = _summary.asStateFlow()

    private val _ready = MutableStateFlow(false)
    val ready: StateFlow<Boolean> = _ready.asStateFlow()

    private val _ctrlState = MutableStateFlow(StickyModifierState.OFF)
    val ctrlState: StateFlow<StickyModifierState> = _ctrlState.asStateFlow()

    private val _altState = MutableStateFlow(StickyModifierState.OFF)
    val altState: StateFlow<StickyModifierState> = _altState.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private var client: TerminalChannelClient? = null
    private var attached = false

    suspend fun connectAndAttach() {
        if (attached && client != null) return
        _error.value = null
        try {
            val channel = obtainChannel()
            val termClient = TerminalChannelClient(
                scope = scope,
                channel = channel,
                onEvent = { ev ->
                    when (ev) {
                        is TerminalStreamEvent.Reset -> {
                            emulator.feedBytes("\u001bc".encodeToByteArray())
                        }
                        is TerminalStreamEvent.Ready -> {
                            _ready.value = true
                        }
                        is TerminalStreamEvent.Output -> {
                            emulator.feedBytes(ev.rawBytes)
                        }
                        is TerminalStreamEvent.Exited -> {
                            _summary.value = _summary.value.copy(exited = true, exitCode = ev.exitCode)
                        }
                        is TerminalStreamEvent.HungUp -> {
                            _summary.value = _summary.value.copy(exited = true)
                        }
                        is TerminalStreamEvent.StreamError -> {
                            _error.value = ev.message
                        }
                    }
                },
            )
            client = termClient
            val attachedSummary = termClient.attach(terminalId)
            _summary.value = attachedSummary
            emulator.resize(attachedSummary.cols, attachedSummary.rows)
            attached = true
        } catch (err: Throwable) {
            _error.value = err.message ?: "Failed to attach terminal"
            throw err
        }
    }

    fun toggleCtrl() {
        _ctrlState.value = _ctrlState.value.next()
    }

    fun toggleAlt() {
        _altState.value = _altState.value.next()
    }

    fun sendUserText(raw: String) {
        if (raw.isEmpty()) return
        var data = raw
        val ctrl = _ctrlState.value != StickyModifierState.OFF
        val alt = _altState.value != StickyModifierState.OFF
        if (ctrl && data.length == 1) {
            val ch = data[0].uppercaseChar()
            if (ch in '@'..'_') {
                data = ((ch.code - 64).toChar()).toString()
            }
        }
        if (alt) {
            data = "\u001b$data"
        }
        if (_ctrlState.value == StickyModifierState.ONCE) _ctrlState.value = StickyModifierState.OFF
        if (_altState.value == StickyModifierState.ONCE) _altState.value = StickyModifierState.OFF

        scope.launch {
            runCatching { client?.sendInput(terminalId, data) }
                .onFailure { _error.value = it.message }
        }
    }

    fun pasteText(clipboardText: String) {
        if (clipboardText.isEmpty()) return
        val wrapped = emulator.formatPaste(clipboardText)
        scope.launch {
            runCatching { client?.sendInput(terminalId, wrapped) }
        }
    }

    fun resize(cols: Int, rows: Int) {
        val c = cols.coerceIn(20, 400)
        val r = rows.coerceIn(6, 160)
        if (c == emulator.snapshot.value.cols && r == emulator.snapshot.value.rows) return
        emulator.resize(c, r)
        scope.launch {
            runCatching { client?.resize(terminalId, c, r) }
        }
    }

    fun close() {
        val c = client
        client = null
        attached = false
        _ready.value = false
        scope.launch {
            c?.detach(terminalId)
            c?.close()
        }
    }
}
