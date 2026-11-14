package ai.yetanother.deskfleet.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// --- Terminals ---

@Serializable
data class TerminalSummary(
    val id: String,
    val title: String = "Terminal",
    val cwd: String = "",
    val shell: String = "",
    val cols: Int = 120,
    val rows: Int = 34,
    val workspaceId: String? = null,
    val worktreeId: String? = null,
    val sessionId: String? = null,
    val exited: Boolean = false,
    val exitCode: Int? = null,
    val createdAt: String = "",
)

@Serializable
data class TerminalDialRequest(
    val mode: String = "create", // "create" | "resume"
    val terminalId: String? = null,
    val workspaceId: String? = null,
    val worktreeId: String? = null,
    val cwd: String? = null,
    val cols: Int = 120,
    val rows: Int = 34,
    val title: String? = null,
)

// --- Files & Transfers ---

@Serializable
data class FileEntry(
    val name: String,
    val path: String,
    val kind: String = "file", // "file" | "directory" | "symlink"
    val size: Long = 0,
    val modifiedAt: String? = null,
    val hidden: Boolean = false,
    val readable: Boolean = true,
    val writable: Boolean = true,
)

@Serializable
data class FileListing(
    val path: String,
    val parent: String? = null,
    val roots: List<String> = emptyList(),
    val homeDirectory: String? = null,
    val entries: List<FileEntry> = emptyList(),
    val grantId: String? = null,
)

@Serializable
sealed interface FileTarget {
    @Serializable
    @SerialName("local")
    data class Local(val grantId: String? = null) : FileTarget

    @Serializable
    @SerialName("machine")
    data class Machine(val teamId: String, val machineId: String, val machineName: String = "") : FileTarget
}

@Serializable
data class FileLocation(
    val target: FileTarget,
    val path: String,
)

enum class FileConflictPolicy(val wire: String) {
    ASK("ask"),
    REPLACE("replace"),
    RENAME("rename"),
    SKIP("skip"),
}

@Serializable
data class FileTransferItem(
    val id: String,
    val name: String,
    val kind: String = "file",
    val source: FileLocation,
    val destination: FileLocation,
    val state: String = "queued", // "queued" | "preparing" | "transferring" | "completed" | "failed" | "cancelled" | "conflict"
    val transferredBytes: Long = 0,
    val totalBytes: Long? = null,
    val bytesPerSecond: Long = 0,
    val error: String? = null,
)

// --- Desktop Media & Input ---

@Serializable
data class DesktopDisplayInfo(
    val id: String,
    val name: String,
    val width: Int,
    val height: Int,
    val scaleFactor: Double = 1.0,
    val primary: Boolean = false,
)

@Serializable
data class DesktopCapabilities(
    val available: Boolean = true,
    val canControl: Boolean = true,
    val secureAttention: Boolean = false,
    val codecs: List<String> = listOf("h264"),
    val displays: List<DesktopDisplayInfo> = emptyList(),
    val reason: String? = null,
)

// --- System Status ---

@Serializable
data class DiskUsageMetric(
    val mountPoint: String,
    val fileSystem: String = "",
    val totalBytes: Long = 0,
    val availableBytes: Long = 0,
    val usedBytes: Long = 0,
)

@Serializable
data class GpuUsageMetric(
    val name: String,
    val utilizationPercent: Double? = null,
    val memoryUsedBytes: Long? = null,
    val memoryTotalBytes: Long? = null,
    val temperatureCelsius: Double? = null,
)

@Serializable
data class SystemStatus(
    val hostname: String = "",
    val osName: String = "",
    val osVersion: String = "",
    val kernelVersion: String = "",
    val arch: String = "",
    val uptimeSeconds: Long = 0,
    val cpuModel: String = "",
    val cpuCores: Int = 1,
    val cpuUsagePercent: Double = 0.0,
    val perCorePercent: List<Double> = emptyList(),
    val loadAverage: List<Double> = emptyList(),
    val memoryTotalBytes: Long = 0,
    val memoryUsedBytes: Long = 0,
    val swapTotalBytes: Long = 0,
    val swapUsedBytes: Long = 0,
    val disks: List<DiskUsageMetric> = emptyList(),
    val gpus: List<GpuUsageMetric> = emptyList(),
    val rxBytesPerSec: Long = 0,
    val txBytesPerSec: Long = 0,
    val sampledAt: String = "",
)

// --- Schedules ---

@Serializable
data class ScheduleTriggerWire(
    val kind: String, // "manual" | "interval" | "daily" | "weekly"
    val minutes: Int? = null,
    val time: String? = null, // "HH:mm"
    val timeZone: String? = null,
    val weekdays: List<Int>? = null,
)

@Serializable
data class ScheduleTargetWire(
    val kind: String, // "new" | "existing"
    val provider: String? = null,
    val context: String? = null, // "worktree" | "directory"
    val configuration: AgentConfigurationSelection? = null,
    val sessionId: String? = null,
)

@Serializable
data class ScheduleInputWire(
    val title: String,
    val prompt: String,
    val workspaceId: String,
    val enabled: Boolean = true,
    val target: ScheduleTargetWire,
    val trigger: ScheduleTriggerWire,
)

@Serializable
data class ScheduleRunWire(
    val id: String,
    val state: String, // "claimed" | "running" | "completed" | "failed" | "interrupted" | "skipped"
    val scheduledFor: String = "",
    val startedAt: String = "",
    val finishedAt: String? = null,
    val sessionId: String? = null,
    val inputId: String? = null,
    val error: String? = null,
)

@Serializable
data class ScheduledTaskWire(
    val id: String,
    val title: String,
    val prompt: String,
    val workspaceId: String,
    val enabled: Boolean = true,
    val target: ScheduleTargetWire,
    val trigger: ScheduleTriggerWire,
    val createdAt: String = "",
    val updatedAt: String = "",
    val nextRunAt: String? = null,
    val runs: List<ScheduleRunWire> = emptyList(),
    val lastRun: ScheduleRunWire? = null,
)

// --- MCP Servers ---

@Serializable
data class McpServerConfigWire(
    val id: String = "",
    val name: String,
    val enabled: Boolean = true,
    val transport: String = "stdio", // "stdio" | "http" | "sse"
    val command: String? = null,
    val args: List<String> = emptyList(),
    val env: Map<String, String> = emptyMap(),
    val url: String? = null,
    val headers: Map<String, String> = emptyMap(),
    val builtIn: Boolean = false,
)

@Serializable
data class McpServerSnapshotWire(
    val revision: String = "0",
    val servers: List<McpServerConfigWire> = emptyList(),
)

// --- Billing & AI Usage ---

@Serializable
data class BillingPriceWire(
    val plan: String,
    val interval: String,
    val unitAmount: Long,
    val currency: String = "usd",
)

@Serializable
data class BillingLimitsWire(
    val maxActiveSessions: Int? = null,
    val maxTurnsPerSession: Int? = null,
    val maxMembers: Int? = null,
    val turnBytes: Long? = null,
)

@Serializable
data class BillingUsageWire(
    val activeSessionCount: Int = 0,
    val memberCount: Int = 1,
    val relayedBytes: String = "0",
)

@Serializable
data class BillingPeriodWire(
    val start: String,
    val end: String,
)

@Serializable
data class BillingSubscriptionWire(
    val plan: String,
    val status: String,
    val paidThrough: String? = null,
    val cancelAtPeriodEnd: Boolean = false,
)

@Serializable
data class ManualGrantWire(
    val plan: String,
    val expiresAt: String? = null,
)

@Serializable
data class TeamBillingWire(
    val prices: List<BillingPriceWire>? = null,
    val plan: String = "free",
    val limits: BillingLimitsWire = BillingLimitsWire(),
    val usage: BillingUsageWire = BillingUsageWire(),
    val period: BillingPeriodWire? = null,
    val nextResetAt: String? = null,
    val enterpriseOverride: Boolean = false,
    val manualGrant: ManualGrantWire? = null,
    val subscription: BillingSubscriptionWire? = null,
    val paymentsAvailable: Boolean = false,
    val canManageBilling: Boolean = false,
    val enterpriseContactEmail: String? = null,
)

@Serializable
data class AdminTeamOwnerWire(
    val id: String,
    val name: String = "",
    val email: String = "",
)

@Serializable
data class AdminTeamBillingWire(
    val id: String,
    val name: String,
    val owner: AdminTeamOwnerWire,
    val billing: TeamBillingWire,
)

@Serializable
data class AdminTeamBillingPageWire(
    val teams: List<AdminTeamBillingWire> = emptyList(),
    val nextCursor: String? = null,
)

@Serializable
data class AiUsageTotalsWire(
    val totalTokens: Long = 0,
    val turnCount: Int = 0,
    val reportedTurnCount: Int = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cachedReadTokens: Long? = null,
    val cachedWriteTokens: Long? = null,
    val thoughtTokens: Long? = null,
)

@Serializable
data class AiUsageGroupWire(
    val id: String,
    val name: String,
    val totalTokens: Long = 0,
    val turnCount: Int = 0,
    val reportedTurnCount: Int = 0,
)

@Serializable
data class AiUsageBucketWire(
    val start: String,
    val totalTokens: Long = 0,
    val turnCount: Int = 0,
    val reportedTurnCount: Int = 0,
    val models: Map<String, Long> = emptyMap(),
    val members: Map<String, Long> = emptyMap(),
)

@Serializable
data class AiUsageDayWire(
    val date: String,
    val totalTokens: Long = 0,
    val turnCount: Int = 0,
    val reportedTurnCount: Int = 0,
)

@Serializable
data class TeamAiUsageWire(
    val period: String = "7d",
    val timeZone: String = "UTC",
    val from: String = "",
    val to: String = "",
    val lastSyncedAt: String? = null,
    val totals: AiUsageTotalsWire = AiUsageTotalsWire(),
    val buckets: List<AiUsageBucketWire> = emptyList(),
    val heatmap: List<AiUsageDayWire> = emptyList(),
    val models: List<AiUsageGroupWire> = emptyList(),
    val members: List<AiUsageGroupWire> = emptyList(),
)

@Serializable
data class AiUsageSessionWire(
    val machineId: String,
    val machineName: String,
    val sessionId: String,
    val title: String,
    val totalTokens: Long = 0,
    val turnCount: Int = 0,
    val reportedTurnCount: Int = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cachedReadTokens: Long? = null,
    val cachedWriteTokens: Long? = null,
    val thoughtTokens: Long? = null,
)

@Serializable
data class TeamAiUsageSessionsWire(
    val date: String,
    val timeZone: String = "UTC",
    val sessions: List<AiUsageSessionWire> = emptyList(),
    val truncated: Boolean = false,
)

// --- Search ---

@Serializable
data class SearchResultWire(
    val kind: String = "chat", // "chat" | "schedule"
    val machineId: String,
    val machineName: String = "",
    val workspaceId: String? = null,
    val workspaceName: String? = null,
    val resourceId: String,
    val title: String,
    val snippet: String = "",
    val updatedAt: String = "",
    val entryId: String? = null,
)

@Serializable
data class SearchPageWire(
    val results: List<SearchResultWire> = emptyList(),
    val nextCursor: String? = null,
)

// --- NAT, Onboarding & Updates ---

@Serializable
data class NatProbeResultWire(
    val server: String,
    val localAddress: String,
    val publicAddress: String? = null,
    val mapping: String = "unknown",
    val filtering: String = "unknown",
    val status: String = "unknown",
    val durationMs: Long = 0,
)

@Serializable
data class UpdateStateWire(
    val status: String = "idle", // "disabled" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "error"
    val currentVersion: String = "0.15.0",
    val version: String? = null,
    val percent: Double? = null,
    val error: String? = null,
)
