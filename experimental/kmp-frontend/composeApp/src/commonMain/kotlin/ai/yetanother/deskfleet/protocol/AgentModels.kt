package ai.yetanother.deskfleet.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class JsonRpcRequest(
    val jsonrpc: String = "2.0",
    val id: Long,
    val method: String,
    val params: JsonElement = JsonObject(emptyMap()),
)

@Serializable
data class JsonRpcResponse(
    val jsonrpc: String = "2.0",
    val id: Long? = null,
    val result: JsonElement? = null,
    val error: JsonRpcError? = null,
)

@Serializable
data class JsonRpcError(
    val code: Int = -32000,
    val message: String = "RPC error",
    val data: JsonElement? = null,
)

@Serializable
data class PromptAttachment(
    val id: String,
    val name: String,
    val mimeType: String = "application/octet-stream",
    val uri: String = "",
    val path: String = "",
    val size: Long = 0,
    val previewBytes: ByteArray? = null,
)

@Serializable
data class PromptBlock(
    val type: String, // "text" | "image" | "resource_link" | "resource"
    val text: String? = null,
    val mimeType: String? = null,
    val data: String? = null,
    val uri: String? = null,
    val name: String? = null,
    val description: String? = null,
)

@Serializable
data class PlanStepItem(
    val content: String,
    val status: String = "pending", // "pending" | "in_progress" | "completed"
    val priority: String? = null,
)

@Serializable
data class PermissionOption(
    val optionId: String,
    val name: String,
    val kind: String = "allow_once", // "allow_once" | "allow_always" | "reject_once" | "reject_always"
)

@Serializable
data class PendingPermissionRequest(
    val requestId: String,
    val sessionId: String,
    val title: String,
    val description: String? = null,
    val toolName: String? = null,
    val command: String? = null,
    val diffPatch: String? = null,
    val options: List<PermissionOption> = emptyList(),
)

@Serializable
data class ElicitationFieldSchema(
    val key: String,
    val label: String,
    val kind: String = "text", // "text" | "boolean" | "select" | "multiselect" | "number"
    val required: Boolean = false,
    val description: String? = null,
    val options: List<String> = emptyList(),
    val defaultValue: String? = null,
)

@Serializable
data class PendingElicitationRequest(
    val requestId: String,
    val sessionId: String,
    val message: String,
    val url: String? = null,
    val fields: List<ElicitationFieldSchema> = emptyList(),
)

@Serializable
data class QueuedPromptItem(
    val inputId: String,
    val text: String,
    val createdAt: String = "",
    val attachments: List<PromptAttachment> = emptyList(),
)

@Serializable
data class ToolCallContentItem(
    val kind: String, // "text" | "diff" | "terminal" | "mcp" | "locations"
    val text: String? = null,
    val path: String? = null,
    val oldText: String? = null,
    val newText: String? = null,
    val terminalId: String? = null,
    val command: String? = null,
    val exitCode: Int? = null,
    val output: String? = null,
    val serverName: String? = null,
    val machineName: String? = null,
    val line: Int? = null,
)

@Serializable
data class ProjectedToolCall(
    val toolCallId: String,
    val title: String,
    val kind: String = "other", // "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "mcp" | "other"
    val status: String = "completed", // "pending" | "in_progress" | "completed" | "failed"
    val rawInput: String? = null,
    val rawOutput: String? = null,
    val locations: List<String> = emptyList(),
    val items: List<ToolCallContentItem> = emptyList(),
    val isRemoteMcp: Boolean = false,
    val remoteMachineName: String? = null,
    val mcpServerName: String? = null,
)

@Serializable
sealed interface TranscriptItem {
    val id: String
    val timestamp: String

    @Serializable
    data class UserTurn(
        override val id: String,
        override val timestamp: String = "",
        val text: String,
        val blocks: List<PromptBlock> = emptyList(),
        val senderName: String? = null,
        val senderAvatarUrl: String? = null,
        val canRetry: Boolean = false,
    ) : TranscriptItem

    @Serializable
    data class AssistantTurn(
        override val id: String,
        override val timestamp: String = "",
        val segments: List<AssistantSegment> = emptyList(),
        val isStreaming: Boolean = false,
        val model: String? = null,
        val durationMs: Long? = null,
        val error: String? = null,
    ) : TranscriptItem

    @Serializable
    data class SystemNotice(
        override val id: String,
        override val timestamp: String = "",
        val message: String,
        val severity: String = "info",
    ) : TranscriptItem
}

@Serializable
sealed interface AssistantSegment {
    val id: String

    @Serializable
    data class MarkdownText(
        override val id: String,
        val markdown: String,
    ) : AssistantSegment

    @Serializable
    data class ThoughtBlock(
        override val id: String,
        val text: String,
        val active: Boolean = false,
    ) : AssistantSegment

    @Serializable
    data class ActivityGroup(
        override val id: String,
        val calls: List<ProjectedToolCall>,
        val active: Boolean = false,
    ) : AssistantSegment

    @Serializable
    data class PlanCard(
        override val id: String,
        val entries: List<PlanStepItem>,
        val awaitingApproval: Boolean = false,
        val requestId: String? = null,
    ) : AssistantSegment
}

@Serializable
data class GitChangedFile(
    val path: String,
    val oldPath: String? = null,
    val status: String = "modified", // "added" | "modified" | "deleted" | "renamed" | "untracked"
    val staged: Boolean = false,
    val additions: Int = 0,
    val deletions: Int = 0,
    val patch: String = "",
    val repoRoot: String = "",
)

@Serializable
data class GitStatusSnapshot(
    val branch: String? = null,
    val ahead: Int = 0,
    val behind: Int = 0,
    val files: List<GitChangedFile> = emptyList(),
    val clean: Boolean = true,
)

@Serializable
data class ComposerCompletionItem(
    val kind: String, // "file" | "skill" | "command"
    val trigger: String, // "@" | "$" | "/"
    val label: String,
    val insertText: String,
    val detail: String? = null,
    val uri: String? = null,
)

@Serializable
data class RecordedSessionEvent(
    val seq: String,
    val kind: String = "acp",
    val createdAt: String = "",
    val payload: JsonElement,
)

@Serializable
data class SessionHistoryPage(
    val events: List<RecordedSessionEvent> = emptyList(),
    val lastSeq: String = "0",
    val hasMore: Boolean = false,
    val gzipBase64: String? = null,
)
