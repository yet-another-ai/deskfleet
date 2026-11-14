package ai.yetanother.deskfleet.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Strictly qualified scope for every Machine resource (`AGENTS.md`:
 * qualify resource access by Team and Machine; a public Machine ID alone is not a scope).
 */
@Serializable
data class MachineScope(
    val teamId: String,
    val machineId: String,
) {
    val key: String get() = "$teamId::$machineId"
}

@Serializable
data class SessionScope(
    val teamId: String,
    val machineId: String,
    val sessionId: String,
) {
    val machineScope: MachineScope get() = MachineScope(teamId, machineId)
    val key: String get() = "$teamId::$machineId::$sessionId"
}

@Serializable
data class WorkspaceSummary(
    val id: String,
    val name: String,
    val directories: List<String> = emptyList(),
    val defaultBranch: String? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
) {
    val primaryDirectory: String get() = directories.firstOrNull().orEmpty()
}

@Serializable
data class WorktreeSummary(
    val id: String,
    val workspaceId: String,
    val name: String = "",
    val branch: String? = null,
    val directories: List<String> = emptyList(),
    val isMain: Boolean = false,
    val sessionId: String? = null,
    val headCommits: Map<String, String> = emptyMap(),
    val hasLocalChanges: Boolean = false,
)

@Serializable
data class SessionViewerPresence(
    val userId: String,
    val name: String = "",
    val email: String = "",
    val avatarUrl: String? = null,
)

@Serializable
data class PullRequestInfo(
    val number: Int,
    val title: String = "",
    val url: String = "",
    val state: String = "open", // "open" | "draft" | "merged" | "closed"
    val reviewDecision: String? = null,
    val checksState: String? = null, // "pending" | "success" | "failure"
    val branch: String = "",
)

@Serializable
data class AgentConfigurationSelection(
    val model: String? = null,
    val reasoningEffort: String? = null,
    val mode: String? = null,
    val configValues: Map<String, String> = emptyMap(),
)

@Serializable
data class SessionUsageSummary(
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cachedReadTokens: Long? = null,
    val cachedWriteTokens: Long? = null,
    val thoughtTokens: Long? = null,
    val contextUsedTokens: Long? = null,
    val contextLimitTokens: Long? = null,
    val costUsd: Double? = null,
)

@Serializable
data class SessionSummary(
    val id: String,
    val workspaceId: String? = null,
    val worktreeId: String? = null,
    val title: String = "Untitled session",
    val provider: String = "codex",
    val context: String = "worktree", // "worktree" | "directory" | "machine"
    val state: String = "idle", // "starting" | "working" | "waiting_permission" | "waiting_input" | "idle" | "stopped" | "interrupted" | "error"
    val archived: Boolean = false,
    val unread: Boolean = false,
    val yolo: Boolean = false,
    val branch: String? = null,
    val directories: List<String> = emptyList(),
    val configuration: AgentConfigurationSelection = AgentConfigurationSelection(),
    val usage: SessionUsageSummary? = null,
    val pullRequest: PullRequestInfo? = null,
    val viewers: List<SessionViewerPresence> = emptyList(),
    val lastError: String? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
) {
    val isWorking: Boolean
        get() = state == "working" || state == "starting"
    val needsAttention: Boolean
        get() = state == "waiting_permission" || state == "waiting_input" || state == "error"
}

@Serializable
data class AgentModelChoice(
    val id: String,
    val label: String,
    val description: String? = null,
    val reasoningEfforts: List<String> = emptyList(),
)

@Serializable
data class AgentModeChoice(
    val id: String,
    val label: String,
    val description: String? = null,
)

@Serializable
data class ProviderRateWindow(
    val label: String,
    val usedPercent: Double,
    val resetsAt: String? = null,
)

@Serializable
data class ProviderSummary(
    val id: String,
    val name: String,
    val installed: Boolean = false,
    val authenticated: Boolean = false,
    val version: String? = null,
    val latestVersion: String? = null,
    val updateAvailable: Boolean = false,
    val executablePath: String? = null,
    val models: List<AgentModelChoice> = emptyList(),
    val modes: List<AgentModeChoice> = emptyList(),
    val defaultModel: String? = null,
    val defaultMode: String? = null,
    val rateWindows: List<ProviderRateWindow> = emptyList(),
    val extra: Map<String, JsonElement> = emptyMap(),
)

@Serializable
data class MachineCatalog(
    val revision: Long = 0,
    val workspaces: List<WorkspaceSummary> = emptyList(),
    val worktrees: List<WorktreeSummary> = emptyList(),
    val sessions: List<SessionSummary> = emptyList(),
    val archivedSessions: List<SessionSummary> = emptyList(),
    val terminals: List<TerminalSummary> = emptyList(),
    val providers: List<ProviderSummary> = emptyList(),
    val hostHomeDirectory: String = "",
)
