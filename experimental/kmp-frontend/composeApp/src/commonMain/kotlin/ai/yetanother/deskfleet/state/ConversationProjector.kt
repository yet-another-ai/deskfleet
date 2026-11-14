package ai.yetanother.deskfleet.state

import ai.yetanother.deskfleet.protocol.*
import kotlinx.serialization.json.*

data class ProjectedConversation(
    val items: List<TranscriptItem> = emptyList(),
    val permissions: List<PendingPermissionRequest> = emptyList(),
    val elicitations: List<PendingElicitationRequest> = emptyList(),
    val backlog: List<QueuedPromptItem> = emptyList(),
    val planSteps: List<PlanStepItem> = emptyList(),
    val title: String? = null,
    val mode: String? = null,
    val model: String? = null,
    val usage: SessionUsageSummary? = null,
    val isStreaming: Boolean = false,
    val lastSeq: String = "0",
)

/**
 * Stateful incremental ACP & Central snapshot projector matching `packages/components/src/services/conversation.ts`:
 * - Projects Central `AgentSnapshot` (`turns`, `permissions`, `elicitations`, `backlog`) AND
 *   live ACP `session/update` notifications (`user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`,
 *   `tool_call`, `tool_call_update`, `plan`, `session_info_update`, `usage_update`, `current_mode_update`).
 * - Groups consecutive tool calls inside an assistant turn into collapsible `AssistantSegment.ActivityGroup`s
 *   and detects remote DeskFleet MCP calls (`mcp_deskfleet_deskfleet_remote_*`).
 */
class ConversationProjector {
    private val items = mutableListOf<TranscriptItem>()
    private val toolCallsById = LinkedHashMap<String, ProjectedToolCall>()
    private val permissionsById = LinkedHashMap<String, PendingPermissionRequest>()
    private val elicitationsById = LinkedHashMap<String, PendingElicitationRequest>()
    private val backlogById = LinkedHashMap<String, QueuedPromptItem>()
    private var planSteps: List<PlanStepItem> = emptyList()
    private var sessionTitle: String? = null
    private var currentMode: String? = null
    private var currentModel: String? = null
    private var usageSummary: SessionUsageSummary? = null
    private var streaming: Boolean = false
    private var lastSeq: String = "0"
    private var turnSeqCounter: Int = 1

    fun reset() {
        items.clear()
        toolCallsById.clear()
        permissionsById.clear()
        elicitationsById.clear()
        backlogById.clear()
        planSteps = emptyList()
        streaming = false
        lastSeq = "0"
        turnSeqCounter = 1
    }

    fun applyCentralSnapshot(snapshotWrapper: JsonObject) {
        val snap = snapshotWrapper["snapshot"] as? JsonObject ?: snapshotWrapper
        snapshotWrapper["lastEventSeq"]?.jsonPrimitive?.contentOrNull?.let { lastSeq = it }
        val sessionObj = snap["session"] as? JsonObject
        sessionObj?.get("title")?.jsonPrimitive?.contentOrNull?.let { sessionTitle = it }
        val turns = snap["turns"] as? JsonArray
        if (turns != null && items.isEmpty()) {
            for (turnEl in turns) {
                val tObj = turnEl as? JsonObject ?: continue
                val turnId = tObj["id"]?.jsonPrimitive?.content ?: "turn-${turnSeqCounter++}"
                val promptText = extractPromptText(tObj["prompt"] ?: tObj["input"])
                if (promptText.isNotBlank()) {
                    items.add(
                        TranscriptItem.UserTurn(
                            id = "$turnId-user",
                            timestamp = tObj["startedAt"]?.jsonPrimitive?.content.orEmpty(),
                            text = promptText,
                        )
                    )
                }
                val respText = tObj["response"]?.jsonPrimitive?.contentOrNull
                    ?: tObj["output"]?.jsonPrimitive?.contentOrNull
                val turnState = tObj["state"]?.jsonPrimitive?.contentOrNull
                if (!respText.isNullOrEmpty() || turnState == "running") {
                    items.add(
                        TranscriptItem.AssistantTurn(
                            id = "$turnId-assistant",
                            timestamp = tObj["endedAt"]?.jsonPrimitive?.content.orEmpty(),
                            segments = if (!respText.isNullOrEmpty()) {
                                listOf(AssistantSegment.MarkdownText("$turnId-md", respText))
                            } else {
                                emptyList()
                            },
                            isStreaming = turnState == "running",
                            error = tObj["error"]?.jsonPrimitive?.contentOrNull,
                        )
                    )
                    if (turnState == "running") streaming = true
                }
            }
        }
        (snap["permissions"] as? JsonArray)?.forEach { pEl ->
            val pObj = pEl as? JsonObject ?: return@forEach
            if (pObj["state"]?.jsonPrimitive?.contentOrNull == "pending") {
                val id = pObj["id"]?.jsonPrimitive?.content ?: return@forEach
                permissionsById[id] = parsePermissionObject(id, pObj)
            }
        }
        (snap["elicitations"] as? JsonArray)?.forEach { eEl ->
            val eObj = eEl as? JsonObject ?: return@forEach
            if (eObj["state"]?.jsonPrimitive?.contentOrNull == "pending") {
                val id = eObj["id"]?.jsonPrimitive?.content ?: return@forEach
                elicitationsById[id] = PendingElicitationRequest(
                    requestId = id,
                    sessionId = sessionObj?.get("id")?.jsonPrimitive?.content.orEmpty(),
                    message = eObj["message"]?.jsonPrimitive?.content ?: "Additional input requested",
                    url = eObj["url"]?.jsonPrimitive?.contentOrNull,
                )
            }
        }
    }

    fun applyRecordedEvents(eventsArray: JsonArray, newLastSeq: String? = null) {
        for (el in eventsArray) {
            val evObj = el as? JsonObject ?: continue
            evObj["seq"]?.jsonPrimitive?.contentOrNull?.let { lastSeq = it }
            val payload = (evObj["payload"] as? JsonObject) ?: evObj
            applyAcpEvent(payload)
        }
        if (!newLastSeq.isNullOrBlank()) lastSeq = newLastSeq
    }

    fun applyAcpNotification(method: String, params: JsonObject) {
        params["seq"]?.jsonPrimitive?.contentOrNull?.let { lastSeq = it }
        when (method) {
            "session/update", "_deskfleet/session/event" -> applyAcpEvent(params)
            "session/request_permission", "_deskfleet/permission/requested" -> {
                val reqId = params["requestId"]?.jsonPrimitive?.content
                    ?: params["id"]?.jsonPrimitive?.content
                    ?: "perm-${turnSeqCounter++}"
                permissionsById[reqId] = parsePermissionObject(reqId, params)
            }
            "_deskfleet/permission/resolved" -> {
                params["requestId"]?.jsonPrimitive?.contentOrNull?.let { permissionsById.remove(it) }
            }
            "_deskfleet/elicitation/requested" -> {
                val reqId = params["requestId"]?.jsonPrimitive?.content ?: "elic-${turnSeqCounter++}"
                elicitationsById[reqId] = PendingElicitationRequest(
                    requestId = reqId,
                    sessionId = params["sessionId"]?.jsonPrimitive?.content.orEmpty(),
                    message = params["message"]?.jsonPrimitive?.content ?: "Input required",
                    url = params["url"]?.jsonPrimitive?.contentOrNull,
                )
            }
            "_deskfleet/elicitation/resolved" -> {
                params["requestId"]?.jsonPrimitive?.contentOrNull?.let { elicitationsById.remove(it) }
            }
        }
    }

    fun addOptimisticUserMessage(text: String, blocks: List<PromptBlock> = emptyList()) {
        val id = "local-user-${turnSeqCounter++}"
        items.add(TranscriptItem.UserTurn(id = id, text = text, blocks = blocks, canRetry = true))
        streaming = true
    }

    fun resolvePermissionLocally(requestId: String) {
        permissionsById.remove(requestId)
    }

    fun resolveElicitationLocally(requestId: String) {
        elicitationsById.remove(requestId)
    }

    private fun applyAcpEvent(obj: JsonObject) {
        val update = (obj["update"] as? JsonObject) ?: obj
        val updateKind = update["sessionUpdate"]?.jsonPrimitive?.contentOrNull
            ?: update["kind"]?.jsonPrimitive?.contentOrNull
            ?: update["type"]?.jsonPrimitive?.contentOrNull

        when (updateKind) {
            "user_message_chunk", "userMessage" -> {
                val chunk = extractContentChunk(update["content"] ?: update)
                if (chunk.isNotEmpty()) appendUserChunk(chunk)
            }
            "agent_message_chunk", "assistantMessage" -> {
                streaming = true
                val chunk = extractContentChunk(update["content"] ?: update)
                if (chunk.isNotEmpty()) appendAssistantMarkdownChunk(chunk)
            }
            "agent_thought_chunk", "thought" -> {
                streaming = true
                val chunk = extractContentChunk(update["content"] ?: update)
                if (chunk.isNotEmpty()) appendAssistantThoughtChunk(chunk)
            }
            "tool_call", "tool_call_update" -> {
                streaming = true
                upsertToolCall(update)
            }
            "plan" -> {
                val entries = (update["entries"] as? JsonArray).orEmpty().mapNotNull { e ->
                    val eo = e as? JsonObject ?: return@mapNotNull null
                    PlanStepItem(
                        content = eo["content"]?.jsonPrimitive?.content.orEmpty(),
                        status = eo["status"]?.jsonPrimitive?.content ?: "pending",
                        priority = eo["priority"]?.jsonPrimitive?.contentOrNull,
                    )
                }
                planSteps = entries
                upsertPlanSegment(entries)
            }
            "session_info_update" -> {
                update["title"]?.jsonPrimitive?.contentOrNull?.let { sessionTitle = it }
            }
            "current_mode_update" -> {
                update["currentModeId"]?.jsonPrimitive?.contentOrNull?.let { currentMode = it }
            }
            "usage_update" -> {
                usageSummary = SessionUsageSummary(
                    inputTokens = update["inputTokens"]?.jsonPrimitive?.longOrNull ?: 0L,
                    outputTokens = update["outputTokens"]?.jsonPrimitive?.longOrNull ?: 0L,
                    cachedReadTokens = update["cachedReadTokens"]?.jsonPrimitive?.longOrNull,
                    thoughtTokens = update["thoughtTokens"]?.jsonPrimitive?.longOrNull,
                    contextUsedTokens = update["used"]?.jsonPrimitive?.longOrNull
                        ?: update["contextUsedTokens"]?.jsonPrimitive?.longOrNull,
                    contextLimitTokens = update["size"]?.jsonPrimitive?.longOrNull
                        ?: update["contextLimitTokens"]?.jsonPrimitive?.longOrNull,
                    costUsd = (update["cost"] as? JsonObject)?.get("amount")?.jsonPrimitive?.doubleOrNull
                        ?: update["costUsd"]?.jsonPrimitive?.doubleOrNull,
                )
            }
            "turn_completed", "turnEnded", "idle" -> {
                streaming = false
                markActiveTurnSettled()
            }
        }
    }

    private fun appendUserChunk(chunk: String) {
        val last = items.lastOrNull()
        if (last is TranscriptItem.UserTurn && !streaming) {
            items[items.lastIndex] = last.copy(text = last.text + chunk)
        } else {
            streaming = false
            items.add(TranscriptItem.UserTurn(id = "user-${turnSeqCounter++}", text = chunk))
        }
    }

    private fun ensureCurrentAssistantTurn(): TranscriptItem.AssistantTurn {
        val last = items.lastOrNull()
        if (last is TranscriptItem.AssistantTurn) return last
        val created = TranscriptItem.AssistantTurn(
            id = "asst-${turnSeqCounter++}",
            isStreaming = true,
            model = currentModel,
        )
        items.add(created)
        return created
    }

    private fun appendAssistantMarkdownChunk(chunk: String) {
        val turn = ensureCurrentAssistantTurn()
        val segs = turn.segments.toMutableList()
        val tail = segs.lastOrNull()
        if (tail is AssistantSegment.MarkdownText) {
            segs[segs.lastIndex] = tail.copy(markdown = tail.markdown + chunk)
        } else {
            segs.add(AssistantSegment.MarkdownText(id = "md-${turnSeqCounter++}", markdown = chunk))
        }
        items[items.lastIndex] = turn.copy(segments = segs, isStreaming = true)
    }

    private fun appendAssistantThoughtChunk(chunk: String) {
        val turn = ensureCurrentAssistantTurn()
        val segs = turn.segments.toMutableList()
        val tail = segs.lastOrNull()
        if (tail is AssistantSegment.ThoughtBlock) {
            segs[segs.lastIndex] = tail.copy(text = tail.text + chunk, active = true)
        } else {
            segs.add(AssistantSegment.ThoughtBlock(id = "th-${turnSeqCounter++}", text = chunk, active = true))
        }
        items[items.lastIndex] = turn.copy(segments = segs, isStreaming = true)
    }

    private fun upsertToolCall(update: JsonObject) {
        val tcId = update["toolCallId"]?.jsonPrimitive?.content
            ?: update["id"]?.jsonPrimitive?.content
            ?: "tc-${turnSeqCounter++}"
        val prev = toolCallsById[tcId]
        val title = update["title"]?.jsonPrimitive?.contentOrNull ?: prev?.title ?: "Tool call"
        val kind = update["kind"]?.jsonPrimitive?.contentOrNull ?: prev?.kind ?: "other"
        val status = update["status"]?.jsonPrimitive?.contentOrNull ?: prev?.status ?: "in_progress"
        val isRemote = title.contains("deskfleet_remote", ignoreCase = true) || prev?.isRemoteMcp == true
        val contentItems = parseToolCallContent(update["content"] as? JsonArray) ?: prev?.items.orEmpty()
        val locs = (update["locations"] as? JsonArray)?.mapNotNull {
            (it as? JsonObject)?.get("path")?.jsonPrimitive?.contentOrNull
        } ?: prev?.locations.orEmpty()

        val updated = ProjectedToolCall(
            toolCallId = tcId,
            title = title,
            kind = kind,
            status = status,
            rawInput = update["rawInput"]?.toString() ?: prev?.rawInput,
            rawOutput = update["rawOutput"]?.toString() ?: prev?.rawOutput,
            locations = locs,
            items = contentItems,
            isRemoteMcp = isRemote,
            remoteMachineName = (update["rawInput"] as? JsonObject)?.get("machineId")?.jsonPrimitive?.contentOrNull
                ?: prev?.remoteMachineName,
            mcpServerName = (update["rawInput"] as? JsonObject)?.get("serverId")?.jsonPrimitive?.contentOrNull
                ?: prev?.mcpServerName,
        )
        toolCallsById[tcId] = updated

        val turn = ensureCurrentAssistantTurn()
        val segs = turn.segments.toMutableList()
        val existingGroupIdx = segs.indexOfFirst { seg ->
            seg is AssistantSegment.ActivityGroup && seg.calls.any { it.toolCallId == tcId }
        }
        if (existingGroupIdx >= 0) {
            val grp = segs[existingGroupIdx] as AssistantSegment.ActivityGroup
            val newCalls = grp.calls.map { if (it.toolCallId == tcId) updated else it }
            segs[existingGroupIdx] = grp.copy(
                calls = newCalls,
                active = newCalls.any { it.status == "pending" || it.status == "in_progress" },
            )
        } else {
            val tail = segs.lastOrNull()
            if (tail is AssistantSegment.ActivityGroup) {
                val newCalls = tail.calls + updated
                segs[segs.lastIndex] = tail.copy(
                    calls = newCalls,
                    active = newCalls.any { it.status == "pending" || it.status == "in_progress" },
                )
            } else {
                segs.add(
                    AssistantSegment.ActivityGroup(
                        id = "act-${turnSeqCounter++}",
                        calls = listOf(updated),
                        active = status == "pending" || status == "in_progress",
                    )
                )
            }
        }
        items[items.lastIndex] = turn.copy(segments = segs, isStreaming = true)
    }

    private fun upsertPlanSegment(entries: List<PlanStepItem>) {
        val turn = ensureCurrentAssistantTurn()
        val segs = turn.segments.toMutableList()
        val idx = segs.indexOfLast { it is AssistantSegment.PlanCard }
        val card = AssistantSegment.PlanCard(id = "plan-1", entries = entries)
        if (idx >= 0) segs[idx] = card else segs.add(card)
        items[items.lastIndex] = turn.copy(segments = segs)
    }

    private fun markActiveTurnSettled() {
        val last = items.lastOrNull()
        if (last is TranscriptItem.AssistantTurn) {
            val settledSegs = last.segments.map { seg ->
                when (seg) {
                    is AssistantSegment.ThoughtBlock -> seg.copy(active = false)
                    is AssistantSegment.ActivityGroup -> seg.copy(active = false)
                    else -> seg
                }
            }
            items[items.lastIndex] = last.copy(segments = settledSegs, isStreaming = false)
        }
    }

    private fun parseToolCallContent(arr: JsonArray?): List<ToolCallContentItem>? {
        if (arr == null) return null
        return arr.mapNotNull { el ->
            val co = el as? JsonObject ?: return@mapNotNull null
            when (co["type"]?.jsonPrimitive?.contentOrNull) {
                "diff" -> ToolCallContentItem(
                    kind = "diff",
                    path = co["path"]?.jsonPrimitive?.contentOrNull,
                    oldText = co["oldText"]?.jsonPrimitive?.contentOrNull,
                    newText = co["newText"]?.jsonPrimitive?.contentOrNull,
                )
                "terminal" -> ToolCallContentItem(
                    kind = "terminal",
                    terminalId = co["terminalId"]?.jsonPrimitive?.contentOrNull,
                )
                else -> {
                    val inner = co["content"] as? JsonObject ?: co
                    ToolCallContentItem(
                        kind = "text",
                        text = inner["text"]?.jsonPrimitive?.contentOrNull ?: co.toString(),
                    )
                }
            }
        }
    }

    private fun parsePermissionObject(id: String, obj: JsonObject): PendingPermissionRequest {
        val tc = obj["toolCall"] as? JsonObject
        val title = tc?.get("title")?.jsonPrimitive?.contentOrNull
            ?: obj["title"]?.jsonPrimitive?.contentOrNull
            ?: "Permission required"
        val opts = (obj["options"] as? JsonArray)?.mapNotNull { o ->
            val oo = o as? JsonObject ?: return@mapNotNull null
            PermissionOption(
                optionId = oo["optionId"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                name = oo["name"]?.jsonPrimitive?.content ?: "Allow",
                kind = oo["kind"]?.jsonPrimitive?.content ?: "allow_once",
            )
        }.takeUnless { it.isNullOrEmpty() } ?: listOf(
            PermissionOption("allow_once", "Allow once", "allow_once"),
            PermissionOption("allow_always", "Always allow", "allow_always"),
            PermissionOption("reject_once", "Deny", "reject_once"),
        )
        return PendingPermissionRequest(
            requestId = id,
            sessionId = obj["sessionId"]?.jsonPrimitive?.content.orEmpty(),
            title = title,
            description = obj["description"]?.jsonPrimitive?.contentOrNull,
            command = (tc?.get("rawInput") as? JsonObject)?.get("command")?.jsonPrimitive?.contentOrNull,
            options = opts,
        )
    }

    private fun extractContentChunk(el: JsonElement?): String {
        if (el == null) return ""
        if (el is JsonPrimitive) return el.contentOrNull.orEmpty()
        if (el is JsonObject) {
            el["text"]?.jsonPrimitive?.contentOrNull?.let { return it }
            (el["content"] as? JsonObject)?.get("text")?.jsonPrimitive?.contentOrNull?.let { return it }
        }
        return ""
    }

    private fun extractPromptText(el: JsonElement?): String {
        if (el == null) return ""
        if (el is JsonPrimitive) return el.contentOrNull.orEmpty()
        if (el is JsonArray) {
            return el.mapNotNull { b -> (b as? JsonObject)?.get("text")?.jsonPrimitive?.contentOrNull }
                .joinToString("\n")
        }
        if (el is JsonObject) return el["text"]?.jsonPrimitive?.contentOrNull.orEmpty()
        return ""
    }

    fun snapshot(): ProjectedConversation = ProjectedConversation(
        items = items.toList(),
        permissions = permissionsById.values.toList(),
        elicitations = elicitationsById.values.toList(),
        backlog = backlogById.values.toList(),
        planSteps = planSteps,
        title = sessionTitle,
        mode = currentMode,
        model = currentModel,
        usage = usageSummary,
        isStreaming = streaming,
        lastSeq = lastSeq,
    )
}
