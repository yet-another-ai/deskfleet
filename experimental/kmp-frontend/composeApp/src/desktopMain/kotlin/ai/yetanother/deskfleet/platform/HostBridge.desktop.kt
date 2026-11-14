package ai.yetanother.deskfleet.platform

import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.transport.CentralRealtimeEvent
import ai.yetanother.deskfleet.transport.DeskFleetChannel
import ai.yetanother.deskfleet.transport.HttpCentralClient
import com.sun.net.httpserver.HttpServer
import java.awt.Desktop
import java.awt.Toolkit
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URI
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

private class DesktopHostBridge : HostBridge {
    private val json = Json { ignoreUnknownKeys = true }

    override val platform: PlatformProfile by lazy {
        val osName = System.getProperty("os.name").orEmpty().lowercase()
        val kind = when {
            osName.contains("mac") || osName.contains("darwin") -> PlatformKind.DARWIN
            osName.contains("win") -> PlatformKind.WIN32
            else -> PlatformKind.LINUX
        }
        val wayland = System.getenv("WAYLAND_DISPLAY")?.isNotBlank() == true ||
            System.getenv("XDG_SESSION_TYPE")?.lowercase() == "wayland"
        val x11 = System.getenv("DISPLAY")?.isNotBlank() == true
        val linuxBackend = if (kind == PlatformKind.LINUX) {
            when {
                wayland -> "wayland"
                x11 -> "x11"
                else -> null
            }
        } else {
            null
        }
        val hostname = runCatching { InetAddress.getLocalHost().hostName }.getOrDefault("localhost")
        PlatformProfile(
            kind = kind,
            osVersion = System.getProperty("os.version").orEmpty(),
            arch = System.getProperty("os.arch").orEmpty(),
            hostname = hostname,
            linuxDesktopBackend = linuxBackend,
        )
    }

    private val appDataDir: File by lazy {
        val override = System.getenv("DESKFLEET_KMP_DATA_DIR")?.takeIf { it.isNotBlank() }
        val dir = if (override != null) {
            File(override)
        } else {
            val home = System.getProperty("user.home").orEmpty()
            when (platform.kind) {
                PlatformKind.DARWIN -> File(home, "Library/Application Support/deskfleet-kmp")
                PlatformKind.WIN32 -> File(System.getenv("APPDATA") ?: "$home/AppData/Roaming", "deskfleet-kmp")
                else -> File(System.getenv("XDG_CONFIG_HOME") ?: "$home/.config", "deskfleet-kmp")
            }
        }
        dir.mkdirs()
        dir
    }

    override fun readPersistedState(fileName: String): String? {
        val f = File(appDataDir, fileName)
        return if (f.isFile) runCatching { f.readText() }.getOrNull() else null
    }

    override fun writePersistedState(fileName: String, content: String) {
        val f = File(appDataDir, fileName)
        f.parentFile?.mkdirs()
        runCatching { f.writeText(content) }
    }

    override suspend fun authenticateWithBrowser(central: HttpCentralClient): AuthUser {
        val codeDeferred = CompletableDeferred<String>()
        val server = withContext(Dispatchers.IO) {
            HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        }
        val port = server.address.port
        val returnTo = "http://127.0.0.1:$port/auth/callback"
        server.createContext("/auth/callback") { exchange ->
            val html = """
                <!DOCTYPE html><html><head><meta charset="utf-8"><title>DeskFleet Sign In</title>
                <style>body{background:#17191f;color:#e7e9ef;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style>
                </head><body><div id="msg">Completing DeskFleet sign-in…</div>
                <script>
                const hash = new URLSearchParams(location.hash.slice(1));
                const query = new URLSearchParams(location.search);
                const code = hash.get('loginCode') || query.get('loginCode') || '';
                if (code) {
                  fetch('/auth/complete?code=' + encodeURIComponent(code)).then(() => {
                    document.getElementById('msg').textContent = 'Signed in! You may close this tab and return to DeskFleet.';
                  });
                } else {
                  document.getElementById('msg').textContent = 'Missing login code.';
                }
                </script></body></html>
            """.trimIndent().toByteArray(StandardCharsets.UTF_8)
            exchange.responseHeaders.add("Content-Type", "text/html; charset=utf-8")
            exchange.sendResponseHeaders(200, html.size.toLong())
            exchange.responseBody.use { it.write(html) }
        }
        server.createContext("/auth/complete") { exchange ->
            val qs = exchange.requestURI.rawQuery.orEmpty()
            val code = qs.split('&')
                .firstOrNull { it.startsWith("code=") }
                ?.removePrefix("code=")
                ?.let { java.net.URLDecoder.decode(it, StandardCharsets.UTF_8) }
                .orEmpty()
            val ok = "ok".toByteArray(StandardCharsets.UTF_8)
            exchange.sendResponseHeaders(200, ok.size.toLong())
            exchange.responseBody.use { it.write(ok) }
            if (code.isNotBlank() && !codeDeferred.isCompleted) {
                codeDeferred.complete(code)
            }
        }
        server.start()
        try {
            val started = central.startBrowserLogin(returnTo)
            openExternalUrl(started.authorizationUrl)
            val loginCode = withTimeout(180_000L) { codeDeferred.await() }
            return central.exchangeLoginCode(loginCode, started.loginVerifier)
        } finally {
            server.stop(0)
        }
    }

    private fun resolveDaemonDir(override: String?): File =
        if (!override.isNullOrBlank()) File(override) else LocalDaemonIpcClient.defaultDaemonDirectory()

    override suspend fun queryLocalDaemonStatus(daemonDirOverride: String?): LocalDaemonStatus {
        val dir = resolveDaemonDir(daemonDirOverride)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        return try {
            val client = LocalDaemonIpcClient.connect(scope, dir)
            try {
                val res = client.call("centralStatus").jsonObject
                val machineName = res["machineName"]?.jsonPrimitive?.content ?: platform.hostname
                val regs = res["registrations"]?.jsonArray.orEmpty().map { el ->
                    val ro = el.jsonObject
                    val idObj = ro["identity"] as? JsonObject
                    LocalDaemonRegistration(
                        configured = ro["configured"]?.jsonPrimitive?.booleanOrNull == true,
                        connected = ro["connected"]?.jsonPrimitive?.booleanOrNull == true,
                        revoked = ro["revoked"]?.jsonPrimitive?.booleanOrNull == true,
                        serverUrl = ro["serverUrl"]?.jsonPrimitive?.contentOrNull,
                        teamId = ro["teamId"]?.jsonPrimitive?.contentOrNull,
                        machineId = ro["machineId"]?.jsonPrimitive?.contentOrNull,
                        originId = idObj?.get("originId")?.jsonPrimitive?.content.orEmpty(),
                        localMachineId = idObj?.get("machineId")?.jsonPrimitive?.content.orEmpty(),
                        machineName = ro["machineName"]?.jsonPrimitive?.content ?: machineName,
                    )
                }
                LocalDaemonStatus(
                    available = true,
                    daemonDirectory = dir.absolutePath,
                    machineName = machineName,
                    registrations = regs,
                )
            } finally {
                client.close()
                scope.cancel()
            }
        } catch (err: Throwable) {
            scope.cancel()
            LocalDaemonStatus(
                available = false,
                daemonDirectory = dir.absolutePath,
                machineName = platform.hostname,
                error = err.message,
            )
        }
    }

    override suspend fun enrollLocalMachine(
        central: HttpCentralClient,
        teamId: String,
        machineName: String?,
        daemonDirOverride: String?,
    ): MachineSummary {
        val dir = resolveDaemonDir(daemonDirOverride)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val client = LocalDaemonIpcClient.connect(scope, dir)
        try {
            val prepared = client.call(
                "centralPrepareEnrollment",
                buildJsonObject {
                    put("serverUrl", central.currentServerUrl)
                    put("teamId", teamId)
                },
            ).jsonObject
            val idObj = prepared["identity"]!!.jsonObject
            val originId = idObj["originId"]!!.jsonPrimitive.content
            val localMachineId = idObj["machineId"]!!.jsonPrimitive.content
            val identityToken = prepared["identityToken"]!!.jsonPrimitive.content
            val chosenName = machineName?.trim()?.takeIf { it.isNotEmpty() }
                ?: prepared["machineName"]?.jsonPrimitive?.content
                ?: platform.hostname
            val (enrolledMachine, machineToken) = central.enrollMachine(
                teamId = teamId,
                name = chosenName,
                originId = originId,
                localMachineId = localMachineId,
                identityToken = identityToken,
            )
            client.call(
                "centralEnroll",
                buildJsonObject {
                    put("serverUrl", central.currentServerUrl)
                    put("machineId", enrolledMachine.id)
                    put("teamId", teamId)
                    put("token", machineToken)
                    put("originId", originId)
                },
            )
            return enrolledMachine
        } finally {
            client.close()
            scope.cancel()
        }
    }

    override suspend fun openLocalDaemonChannel(
        scope: CoroutineScope,
        central: HttpCentralClient,
        machineScope: MachineScope,
        purpose: String,
        daemonDirOverride: String?,
    ): DeskFleetChannel? {
        if (purpose != "agent" && purpose != "terminal") return null
        val dir = resolveDaemonDir(daemonDirOverride)
        if (!File(dir, "daemon.json").isFile) return null
        return runCatching {
            val status = queryLocalDaemonStatus(daemonDirOverride)
            val matching = status.registrations.firstOrNull { reg ->
                reg.configured && !reg.revoked &&
                    reg.serverUrl?.trimEnd('/') == central.currentServerUrl.trimEnd('/') &&
                    reg.teamId == machineScope.teamId &&
                    reg.machineId == machineScope.machineId
            } ?: return null

            val grant = central.createLocalPeer(machineScope.teamId, machineScope.machineId, purpose)
            val channel = LocalDaemonChannel(
                scope = scope,
                peerId = grant.peerId,
                onCleanupPeer = { central.closePeer(grant.peerId) },
            )
            val ipc = LocalDaemonIpcClient.connect(
                scope = scope,
                daemonDir = dir,
                onDaemonEvent = { ev -> channel.handleDaemonEvent(ev) },
                onDisconnected = { err -> channel.close(err) },
            )
            channel.ipcClient = ipc
            ipc.call(
                "localOpen",
                buildJsonObject {
                    put("peerId", grant.peerId)
                    put("token", grant.token)
                    put("teamId", matching.teamId ?: machineScope.teamId)
                    put("machineId", matching.machineId ?: machineScope.machineId)
                },
            )
            channel.markOpen()
            channel
        }.getOrNull()
    }

    override suspend fun listLocalFiles(path: String?): FileListing = withContext(Dispatchers.IO) {
        val home = System.getProperty("user.home").orEmpty()
        val targetDir = File(path?.takeIf { it.isNotBlank() } ?: home).canonicalFile
        val roots = File.listRoots()?.map { it.absolutePath }.orEmpty()
        val entries = targetDir.listFiles()?.map { f ->
            FileEntry(
                name = f.name,
                path = f.absolutePath,
                kind = when {
                    Files.isSymbolicLink(f.toPath()) -> "symlink"
                    f.isDirectory -> "directory"
                    else -> "file"
                },
                size = if (f.isFile) f.length() else 0L,
                modifiedAt = f.lastModified().toString(),
                hidden = f.isHidden || f.name.startsWith("."),
                readable = f.canRead(),
                writable = f.canWrite(),
            )
        }?.sortedWith(compareBy<FileEntry>({ it.kind != "directory" }, { it.name.lowercase() })).orEmpty()

        FileListing(
            path = targetDir.absolutePath,
            parent = targetDir.parentFile?.absolutePath,
            roots = roots,
            homeDirectory = home,
            entries = entries,
        )
    }

    override suspend fun readLocalFileBytes(path: String): ByteArray = withContext(Dispatchers.IO) {
        File(path).readBytes()
    }

    override suspend fun writeLocalFileBytes(
        directory: String,
        fileName: String,
        bytes: ByteArray,
        conflict: FileConflictPolicy,
    ): String = withContext(Dispatchers.IO) {
        val dir = File(directory).apply { mkdirs() }
        var dest = File(dir, fileName)
        if (dest.exists()) {
            when (conflict) {
                FileConflictPolicy.SKIP -> return@withContext dest.absolutePath
                FileConflictPolicy.ASK -> error("File already exists: ${dest.name}")
                FileConflictPolicy.REPLACE -> Unit
                FileConflictPolicy.RENAME -> {
                    val stem = fileName.substringBeforeLast('.', fileName)
                    val ext = fileName.substringAfterLast('.', "").let { if (it.isEmpty() || stem == fileName) "" else ".$it" }
                    var idx = 1
                    while (dest.exists()) {
                        dest = File(dir, "$stem ($idx)$ext")
                        idx += 1
                    }
                }
            }
        }
        dest.writeBytes(bytes)
        dest.absolutePath
    }

    override fun availableEditors(): List<ExternalEditorApp> {
        val candidates = when (platform.kind) {
            PlatformKind.DARWIN -> listOf(
                ExternalEditorApp("vscode", "VS Code", "code"),
                ExternalEditorApp("cursor", "Cursor", "cursor"),
                ExternalEditorApp("zed", "Zed", "zed"),
                ExternalEditorApp("terminal", "Terminal", "open -a Terminal"),
                ExternalEditorApp("finder", "Finder", "open"),
            )
            PlatformKind.WIN32 -> listOf(
                ExternalEditorApp("vscode", "VS Code", "code.cmd"),
                ExternalEditorApp("cursor", "Cursor", "cursor.cmd"),
                ExternalEditorApp("explorer", "Explorer", "explorer.exe"),
            )
            else -> listOf(
                ExternalEditorApp("vscode", "VS Code", "code"),
                ExternalEditorApp("zed", "Zed", "zed"),
                ExternalEditorApp("files", "File Manager", "xdg-open"),
            )
        }
        return candidates
    }

    override fun openInEditor(editorId: String, directoryPath: String): Boolean = runCatching {
        when {
            editorId == "finder" && platform.kind == PlatformKind.DARWIN ->
                ProcessBuilder("open", directoryPath).start()
            editorId == "terminal" && platform.kind == PlatformKind.DARWIN ->
                ProcessBuilder("open", "-a", "Terminal", directoryPath).start()
            editorId == "explorer" && platform.kind == PlatformKind.WIN32 ->
                ProcessBuilder("explorer.exe", directoryPath).start()
            editorId == "files" ->
                ProcessBuilder("xdg-open", directoryPath).start()
            else -> {
                val cmd = availableEditors().firstOrNull { it.id == editorId }?.command ?: return false
                ProcessBuilder(cmd, directoryPath).start()
            }
        }
        true
    }.getOrDefault(false)

    override suspend fun launchNativeDesktopViewer(
        scope: CoroutineScope,
        central: HttpCentralClient,
        machineScope: MachineScope,
        title: String,
        control: Boolean,
    ): Boolean = withContext(Dispatchers.IO) {
        val viewerCandidates = listOfNotNull(
            System.getenv("DESKFLEET_VIEWER_BIN"),
            "../../target/release/deskfleet-viewer",
            "../../target/debug/deskfleet-viewer",
            "/Applications/deskfleet.app/Contents/Resources/deskfleet-viewer",
        ).map { File(it) }
        val bin = viewerCandidates.firstOrNull { it.isFile && it.canExecute() } ?: return@withContext false
        runCatching {
            val proc = ProcessBuilder(bin.absolutePath).redirectErrorStream(false).start()
            val grant = central.createPeer(machineScope.teamId, machineScope.machineId, "desktop")
            val stdin = proc.outputStream.bufferedWriter(StandardCharsets.UTF_8)
            val stdout = BufferedReader(InputStreamReader(proc.inputStream, StandardCharsets.UTF_8))

            fun sendViewerCmd(obj: JsonObject) {
                stdin.write(json.encodeToString(JsonObject.serializer(), obj))
                stdin.newLine()
                stdin.flush()
            }

            sendViewerCmd(
                buildJsonObject {
                    put("type", "start")
                    put("title", title)
                    put("control", control)
                    put("iceServers", json.encodeToJsonElement(grant.iceServers))
                }
            )

            val wsSub = scope.launch {
                central.events.collect { ev ->
                    if (ev is CentralRealtimeEvent.PeerEvent && ev.peerId == grant.peerId) {
                        val cand = ev.event["candidate"]
                        if (cand != null) {
                            sendViewerCmd(buildJsonObject {
                                put("type", "candidate")
                                put("candidate", cand)
                            })
                        }
                    }
                }
            }

            scope.launch(Dispatchers.IO) {
                try {
                    while (isActive) {
                        val line = stdout.readLine() ?: break
                        val msg = runCatching { json.parseToJsonElement(line).jsonObject }.getOrNull() ?: continue
                        when (msg["type"]?.jsonPrimitive?.contentOrNull) {
                            "offer" -> {
                                val sdp = msg["sdp"]?.jsonPrimitive?.content ?: continue
                                val codec = msg["codec"]?.jsonPrimitive?.contentOrNull ?: "h264"
                                val ans = central.offerPeer(grant.peerId, sdp, PeerOfferOptionsWire(codec = codec))
                                sendViewerCmd(buildJsonObject {
                                    put("type", "answer")
                                    put("sdp", ans.sdp)
                                })
                                central.startPeer(grant.peerId, buildJsonObject { put("control", control) })
                            }
                            "candidate" -> {
                                val c = msg["candidate"]?.let {
                                    json.decodeFromJsonElement(IceCandidateWire.serializer(), it)
                                } ?: continue
                                central.candidatePeer(grant.peerId, c)
                            }
                        }
                    }
                } finally {
                    wsSub.cancel()
                    central.closePeer(grant.peerId)
                }
            }
            true
        }.getOrDefault(false)
    }

    override fun openExternalUrl(url: String) {
        runCatching {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(URI(url))
            } else {
                when (platform.kind) {
                    PlatformKind.DARWIN -> ProcessBuilder("open", url).start()
                    PlatformKind.WIN32 -> ProcessBuilder("cmd", "/c", "start", "", url).start()
                    else -> ProcessBuilder("xdg-open", url).start()
                }
            }
        }
    }

    override fun copyToClipboard(text: String) {
        runCatching {
            Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(text), null)
        }
    }

    override fun readFromClipboard(): String? = runCatching {
        Toolkit.getDefaultToolkit().systemClipboard.getData(DataFlavor.stringFlavor) as? String
    }.getOrNull()

    private var caffeinateProcess: Process? = null
    override fun setKeepAwake(enabled: Boolean) {
        if (enabled) {
            if (caffeinateProcess?.isAlive == true) return
            caffeinateProcess = runCatching {
                when (platform.kind) {
                    PlatformKind.DARWIN -> ProcessBuilder("caffeinate", "-di").start()
                    else -> null
                }
            }.getOrNull()
        } else {
            caffeinateProcess?.destroy()
            caffeinateProcess = null
        }
    }

    override fun postNotification(title: String, body: String) {
        runCatching {
            when (platform.kind) {
                PlatformKind.DARWIN -> {
                    val safeTitle = title.replace("\"", "\\\"")
                    val safeBody = body.replace("\"", "\\\"")
                    ProcessBuilder(
                        "osascript",
                        "-e",
                        "display notification \"$safeBody\" with title \"$safeTitle\"",
                    ).start()
                }
                PlatformKind.LINUX -> ProcessBuilder("notify-send", title, body).start()
                else -> Unit
            }
        }
    }

    override suspend fun checkForUpdates(): UpdateStateWire = UpdateStateWire(
        status = "idle",
        currentVersion = "0.15.0",
    )
}

actual fun createPlatformHostBridge(): HostBridge = DesktopHostBridge()
