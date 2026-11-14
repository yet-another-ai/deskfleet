package ai.yetanother.deskfleet.state

import ai.yetanother.deskfleet.protocol.*
import kotlinx.serialization.json.*

internal fun parseCatalogWorkspacesAndWorktrees(snap: JsonObject): Pair<List<WorkspaceSummary>, List<WorktreeSummary>> {
    val collectedWorktrees = mutableListOf<WorktreeSummary>()
    val seenWorktreeIds = mutableSetOf<String>()

    fun parseWorktree(wto: JsonObject, fallbackWorkspaceId: String = ""): WorktreeSummary? {
        val id = wto["id"]?.jsonPrimitive?.contentOrNull ?: return null
        if (!seenWorktreeIds.add(id)) return null
        val dirs = (wto["directories"] as? JsonArray).orEmpty().mapNotNull { d ->
            (d as? JsonObject)?.get("path")?.jsonPrimitive?.contentOrNull
                ?: (d as? JsonPrimitive)?.contentOrNull
        }
        return WorktreeSummary(
            id = id,
            workspaceId = wto["workspaceId"]?.jsonPrimitive?.contentOrNull ?: fallbackWorkspaceId,
            name = wto["name"]?.jsonPrimitive?.content.orEmpty(),
            branch = wto["branch"]?.jsonPrimitive?.contentOrNull,
            directories = dirs,
            isMain = wto["isMain"]?.jsonPrimitive?.booleanOrNull ?: (wto["sessionId"]?.jsonPrimitive?.contentOrNull == null),
            sessionId = wto["sessionId"]?.jsonPrimitive?.contentOrNull,
        )
    }

    val workspaces = (snap["workspaces"] as? JsonArray).orEmpty().mapNotNull { w ->
        val wo = w as? JsonObject ?: return@mapNotNull null
        val wsId = wo["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
        val nestedWorktrees = (wo["worktrees"] as? JsonArray).orEmpty().mapNotNull { wt ->
            (wt as? JsonObject)?.let { parseWorktree(it, wsId) }
        }
        collectedWorktrees.addAll(nestedWorktrees)
        val directDirs = (wo["directories"] as? JsonArray).orEmpty().mapNotNull { d ->
            (d as? JsonObject)?.get("path")?.jsonPrimitive?.contentOrNull
                ?: (d as? JsonPrimitive)?.contentOrNull
        }.ifEmpty {
            nestedWorktrees.firstOrNull { it.isMain }?.directories.orEmpty()
        }
        WorkspaceSummary(
            id = wsId,
            name = wo["name"]?.jsonPrimitive?.content ?: "Workspace",
            directories = directDirs,
            defaultBranch = wo["defaultBranch"]?.jsonPrimitive?.contentOrNull,
            createdAt = wo["createdAt"]?.jsonPrimitive?.content.orEmpty(),
            updatedAt = wo["updatedAt"]?.jsonPrimitive?.content.orEmpty(),
        )
    }

    (snap["worktrees"] as? JsonArray).orEmpty().forEach { wt ->
        (wt as? JsonObject)?.let { parseWorktree(it)?.let(collectedWorktrees::add) }
    }

    return workspaces to collectedWorktrees
}

internal fun parseSessionSummaryObject(rawRow: JsonObject): SessionSummary? {
    val so = (rawRow["session"] as? JsonObject) ?: rawRow
    val id = so["id"]?.jsonPrimitive?.contentOrNull ?: return null
    val archiveState = so["archiveState"]?.jsonPrimitive?.contentOrNull
    val archived = so["archived"]?.jsonPrimitive?.booleanOrNull ?: (archiveState == "archived")
    val runState = so["runState"]?.jsonPrimitive?.contentOrNull
        ?: so["state"]?.jsonPrimitive?.contentOrNull
        ?: "idle"
    val prObj = so["pullRequest"] as? JsonObject
    val pr = prObj?.get("number")?.jsonPrimitive?.intOrNull?.let { num ->
        PullRequestInfo(
            number = num,
            title = prObj["title"]?.jsonPrimitive?.content.orEmpty(),
            url = prObj["url"]?.jsonPrimitive?.content.orEmpty(),
            state = prObj["state"]?.jsonPrimitive?.content ?: "open",
            checksState = prObj["checksState"]?.jsonPrimitive?.contentOrNull,
        )
    }
    return SessionSummary(
        id = id,
        workspaceId = so["workspaceId"]?.jsonPrimitive?.contentOrNull,
        worktreeId = so["worktreeId"]?.jsonPrimitive?.contentOrNull,
        title = so["title"]?.jsonPrimitive?.content ?: "Untitled session",
        provider = so["provider"]?.jsonPrimitive?.content ?: "codex",
        context = so["context"]?.jsonPrimitive?.content ?: "worktree",
        state = runState,
        archived = archived,
        unread = so["unread"]?.jsonPrimitive?.booleanOrNull == true,
        branch = so["branch"]?.jsonPrimitive?.contentOrNull,
        pullRequest = pr,
        createdAt = so["createdAt"]?.jsonPrimitive?.content.orEmpty(),
        updatedAt = so["updatedAt"]?.jsonPrimitive?.content.orEmpty(),
    )
}

internal fun parseSystemStatusPayload(
    json: Json,
    o: JsonObject,
    fallbackMachine: MachineSummary,
): SystemStatus {
    val cpuObj = o["cpu"] as? JsonObject
    val memObj = o["memory"] as? JsonObject
    val netObj = o["network"] as? JsonObject
    return SystemStatus(
        hostname = o["hostname"]?.jsonPrimitive?.content ?: fallbackMachine.hostname,
        osName = o["osName"]?.jsonPrimitive?.content ?: fallbackMachine.os,
        osVersion = o["osVersion"]?.jsonPrimitive?.content ?: (o["daemonVersion"]?.jsonPrimitive?.content.orEmpty()),
        arch = o["arch"]?.jsonPrimitive?.content ?: fallbackMachine.arch,
        uptimeSeconds = o["uptimeSeconds"]?.jsonPrimitive?.longOrNull ?: 0L,
        cpuModel = cpuObj?.get("brand")?.jsonPrimitive?.content
            ?: o["cpuModel"]?.jsonPrimitive?.content.orEmpty(),
        cpuCores = cpuObj?.get("cores")?.jsonPrimitive?.intOrNull
            ?: o["cpuCores"]?.jsonPrimitive?.intOrNull ?: 1,
        cpuUsagePercent = cpuObj?.get("usagePercent")?.jsonPrimitive?.doubleOrNull
            ?: o["cpuUsagePercent"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
        perCorePercent = ((cpuObj?.get("perCoreUsagePercent") ?: o["perCorePercent"]) as? JsonArray)
            .orEmpty().mapNotNull { it.jsonPrimitive.doubleOrNull },
        memoryTotalBytes = memObj?.get("totalBytes")?.jsonPrimitive?.longOrNull
            ?: o["memoryTotalBytes"]?.jsonPrimitive?.longOrNull ?: 0L,
        memoryUsedBytes = memObj?.get("usedBytes")?.jsonPrimitive?.longOrNull
            ?: o["memoryUsedBytes"]?.jsonPrimitive?.longOrNull ?: 0L,
        swapTotalBytes = memObj?.get("swapTotalBytes")?.jsonPrimitive?.longOrNull
            ?: o["swapTotalBytes"]?.jsonPrimitive?.longOrNull ?: 0L,
        swapUsedBytes = memObj?.get("swapUsedBytes")?.jsonPrimitive?.longOrNull
            ?: o["swapUsedBytes"]?.jsonPrimitive?.longOrNull ?: 0L,
        disks = (o["disks"] as? JsonArray).orEmpty().mapNotNull { d ->
            runCatching { json.decodeFromJsonElement(DiskUsageMetric.serializer(), d) }.getOrNull()
        },
        gpus = (o["gpus"] as? JsonArray).orEmpty().mapNotNull { g ->
            runCatching { json.decodeFromJsonElement(GpuUsageMetric.serializer(), g) }.getOrNull()
        },
        rxBytesPerSec = netObj?.get("rxBytesPerSec")?.jsonPrimitive?.longOrNull
            ?: o["rxBytesPerSec"]?.jsonPrimitive?.longOrNull ?: 0L,
        txBytesPerSec = netObj?.get("txBytesPerSec")?.jsonPrimitive?.longOrNull
            ?: o["txBytesPerSec"]?.jsonPrimitive?.longOrNull ?: 0L,
    )
}

internal fun buildMcpServerWireInput(server: McpServerConfigWire): JsonObject =
    if (server.transport == "stdio") {
        buildJsonObject {
            put("name", server.name.trim())
            put("enabled", server.enabled)
            put("transport", "stdio")
            put("command", server.command.orEmpty().trim())
            put("args", JsonArray(server.args.map { JsonPrimitive(it) }))
            put("env", buildJsonObject { server.env.forEach { (k, v) -> put(k, v) } })
        }
    } else {
        buildJsonObject {
            put("name", server.name.trim())
            put("enabled", server.enabled)
            put("transport", server.transport)
            put("url", server.url.orEmpty().trim())
            put("headers", buildJsonObject { server.headers.forEach { (k, v) -> put(k, v) } })
        }
    }
