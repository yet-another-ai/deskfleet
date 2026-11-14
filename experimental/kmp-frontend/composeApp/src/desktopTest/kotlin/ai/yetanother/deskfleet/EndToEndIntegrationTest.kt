package ai.yetanother.deskfleet

import ai.yetanother.deskfleet.platform.PlatformKind
import ai.yetanother.deskfleet.platform.PlatformProfile
import ai.yetanother.deskfleet.platform.createPlatformHostBridge
import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.state.AppController
import ai.yetanother.deskfleet.state.ConversationProjector
import ai.yetanother.deskfleet.terminal.TerminalCell
import ai.yetanother.deskfleet.terminal.VtTerminalEmulator
import ai.yetanother.deskfleet.transport.*
import ai.yetanother.deskfleet.ui.theme.SpringController
import ai.yetanother.deskfleet.ui.theme.SpringParameters
import ai.yetanother.deskfleet.ui.theme.oklchToColor
import java.io.File
import java.nio.file.Files
import kotlin.test.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class EndToEndIntegrationTest {

    @Test
    fun testPlatformParityMatrix() {
        val mac = PlatformProfile(kind = PlatformKind.DARWIN)
        assertTrue(mac.hasMacTrafficLights)
        assertFalse(mac.hasRightWindowControlsInset)
        assertFalse(mac.suppressBillingPricing)
        assertEquals(
            listOf("localNetwork", "fullDiskAccess", "screenCapture", "accessibility"),
            mac.onboardingSteps(localAgent = true),
        )

        val win = PlatformProfile(kind = PlatformKind.WIN32)
        assertFalse(win.hasMacTrafficLights)
        assertTrue(win.hasRightWindowControlsInset)
        assertEquals(listOf("windowsDesktopService"), win.onboardingSteps(localAgent = true))

        val linuxWayland = PlatformProfile(kind = PlatformKind.LINUX, linuxDesktopBackend = "wayland")
        assertEquals(listOf("screenCapture", "accessibility"), linuxWayland.onboardingSteps(localAgent = true))
        val linuxX11 = PlatformProfile(kind = PlatformKind.LINUX, linuxDesktopBackend = "x11")
        assertTrue(linuxX11.onboardingSteps(localAgent = true).isEmpty())

        val ios = PlatformProfile(kind = PlatformKind.IOS)
        val android = PlatformProfile(kind = PlatformKind.ANDROID)
        assertTrue(ios.isMobile && ios.suppressBillingPricing && !ios.supportsLocalDaemon && !ios.supportsNativeDesktopViewer)
        assertTrue(android.isMobile && android.suppressBillingPricing && !android.supportsLocalDaemon && !android.supportsNativeDesktopViewer)
        assertTrue(ios.onboardingSteps().isEmpty())
        assertTrue(android.onboardingSteps().isEmpty())

        val web = PlatformProfile(kind = PlatformKind.WEB)
        assertTrue(web.isWeb && !web.isDesktop && !web.isMobile)
        assertFalse(web.suppressBillingPricing)
        assertTrue(web.usesCookieSessionOnly && web.locksServerUrlToOrigin)
        assertTrue(web.supportsHoverTooltips && !web.supportsLocalDaemon && !web.supportsNativeDesktopViewer)
        assertTrue(web.onboardingSteps().isEmpty())
    }

    @Test
    fun testFixed4MuxFramingFlowControlAndCrossLaneOrdering() = runBlocking {
        lateinit var clientMux: MuxConnection
        lateinit var serverMux: MuxConnection
        val serverOpenedStreams = mutableListOf<DeskFleetChannel>()

        clientMux = MuxConnection(
            scope = this,
            isClient = true,
            sendPhysical = { lane, bytes -> serverMux.receivePhysical(lane, bytes) },
        )
        serverMux = MuxConnection(
            scope = this,
            isClient = false,
            sendPhysical = { lane, bytes -> clientMux.receivePhysical(lane, bytes) },
            onAccept = { ch ->
                serverOpenedStreams.add(ch)
                ch.onMessage = { payload ->
                    when (payload) {
                        is ChannelPayload.Text -> ch.sendText("echo:${payload.text}")
                        is ChannelPayload.Binary -> ch.sendBinary(payload.bytes.reversedArray(), bulk = true)
                    }
                }
            },
        )

        val agentStream = clientMux.openStream(MuxPurpose.AGENT)
        withTimeout(3_000L) { agentStream.ready.await() }
        assertEquals(1, serverOpenedStreams.size)

        val textReply = CompletableDeferred<String>()
        val binReply = CompletableDeferred<ByteArray>()
        agentStream.onMessage = { payload ->
            when (payload) {
                is ChannelPayload.Text -> textReply.complete(payload.text)
                is ChannelPayload.Binary -> binReply.complete(payload.bytes)
            }
        }

        // Send a 40 KiB binary payload (> 16 KiB frame size, exercises multi-frame slicing + credit return)
        val largePayload = ByteArray(40 * 1024) { idx -> (idx % 251).toByte() }
        agentStream.sendBinary(largePayload, bulk = true)
        agentStream.sendText("hello-mux")

        assertContentEquals(largePayload.reversedArray(), withTimeout(3_000L) { binReply.await() })
        assertEquals("echo:hello-mux", withTimeout(3_000L) { textReply.await() })

        clientMux.close()
        serverMux.close()
    }

    @Test
    fun testFileFrameStreamDecoderAcrossByteSplits() {
        val json = Json { ignoreUnknownKeys = true }
        val decoder = FileFrameStreamDecoder(json)
        val hdr = """{"id":7,"value":{"ok":true}}""".encodeToByteArray()
        val data = ByteArray(1024) { (it and 0xFF).toByte() }
        val full = ByteArray(8 + hdr.size + data.size)
        val hLen = hdr.size
        val dLen = data.size
        full[0] = ((hLen ushr 24) and 0xFF).toByte()
        full[1] = ((hLen ushr 16) and 0xFF).toByte()
        full[2] = ((hLen ushr 8) and 0xFF).toByte()
        full[3] = (hLen and 0xFF).toByte()
        full[4] = ((dLen ushr 24) and 0xFF).toByte()
        full[5] = ((dLen ushr 16) and 0xFF).toByte()
        full[6] = ((dLen ushr 8) and 0xFF).toByte()
        full[7] = (dLen and 0xFF).toByte()
        hdr.copyInto(full, 8)
        data.copyInto(full, 8 + hdr.size)

        // Feed in 3-byte slices to verify streaming boundary reassembly
        val decoded = mutableListOf<DecodedFileFrame>()
        var pos = 0
        while (pos < full.size) {
            val end = minOf(full.size, pos + 3)
            decoded.addAll(decoder.push(full.copyOfRange(pos, end)))
            pos = end
        }
        assertEquals(1, decoded.size)
        assertContentEquals(data, decoded[0].data)
    }

    @Test
    fun testVtTerminalEmulatorUtf8TrueColorAltScreenAndOsc() {
        val vt = VtTerminalEmulator(initialCols = 40, initialRows = 10)
        // Split a 3-byte UTF-8 CJK character ("中" = E4 B8 AD) across two feed() calls + 24-bit TrueColor SGR
        val seq1 = "\u001b]0;MyShell\u0007\u001b]9;4;1;65\u0007\u001b[38;2;12;200;99mHi ".encodeToByteArray() + byteArrayOf(0xE4.toByte())
        val seq2 = byteArrayOf(0xB8.toByte(), 0xAD.toByte()) + "\u001b[0m".encodeToByteArray()
        vt.feedBytes(seq1)
        vt.feedBytes(seq2)

        val snap = vt.snapshot.value
        assertEquals("MyShell", snap.windowTitle)
        assertEquals(65, snap.oscProgressPercent)
        assertEquals('H', snap.screenLines[0][0].ch)
        assertEquals(TerminalCell.rgb(12, 200, 99), snap.screenLines[0][0].fg)
        assertEquals('中', snap.screenLines[0][3].ch)

        // Enter alt screen, write text, exit alt screen -> primary screen preserved!
        vt.feedBytes("\u001b[?1049hALT".encodeToByteArray())
        assertTrue(vt.snapshot.value.altScreen)
        vt.feedBytes("\u001b[?1049l".encodeToByteArray())
        assertFalse(vt.snapshot.value.altScreen)
        assertEquals('中', vt.snapshot.value.screenLines[0][3].ch)
        assertTrue(vt.exportHtml().contains("中"))
    }

    @Test
    fun testSpringPhysicsAndOklchPaletteAndProjector() {
        val spring = SpringController(0f, SpringParameters(duration = 0.35, bounce = 0.15))
        spring.animateTo(100f)
        repeat(120) { spring.step(1.0 / 60.0) }
        assertTrue(spring.isSettled)
        assertEquals(100f, spring.value, 0.01f)

        val col = oklchToColor(0.73, 0.14, 264.0)
        assertTrue(col.alpha == 1f && col.blue > 0.4f)

        val proj = ConversationProjector()
        proj.applyAcpNotification(
            "session/update",
            buildJsonObject {
                put("sessionUpdate", "agent_thought_chunk")
                put("content", buildJsonObject { put("text", "Checking repo") })
            },
        )
        proj.applyAcpNotification(
            "session/update",
            buildJsonObject {
                put("sessionUpdate", "tool_call")
                put("toolCallId", "tc-1")
                put("title", "Read Cargo.toml")
                put("status", "completed")
            },
        )
        proj.applyAcpNotification(
            "session/update",
            buildJsonObject {
                put("sessionUpdate", "agent_message_chunk")
                put("content", buildJsonObject { put("text", "All set!") })
            },
        )
        proj.applyAcpNotification("session/update", buildJsonObject { put("sessionUpdate", "turn_completed") })
        val snap = proj.snapshot()
        assertFalse(snap.isStreaming)
        assertEquals(1, snap.items.size)
    }

    /**
     * Live end-to-end verification against a real running `deskfleet-server` + `apps/daemon`!
     * Activated when `DESKFLEET_LIVE_E2E_URL` and `DESKFLEET_LIVE_DAEMON_DIR` are supplied.
     */
    @Test
    fun testLiveServerAndDaemonEndToEnd() = runBlocking {
        val serverUrl = System.getenv("DESKFLEET_LIVE_E2E_URL")?.takeIf { it.isNotBlank() } ?: return@runBlocking
        val daemonDir = System.getenv("DESKFLEET_LIVE_DAEMON_DIR")?.takeIf { it.isNotBlank() } ?: return@runBlocking
        val email = System.getenv("DESKFLEET_LIVE_EMAIL") ?: "admin@deskfleet.test"
        val password = System.getenv("DESKFLEET_LIVE_PASSWORD") ?: "deskfleet-dev-password"

        val tempStateDir = Files.createTempDirectory("deskfleet-kmp-e2e-state").toFile()
        val sampleWorkspaceDir = Files.createTempDirectory("deskfleet-kmp-e2e-ws").toFile()
        ProcessBuilder("git", "init", sampleWorkspaceDir.absolutePath).start().waitFor()
        File(sampleWorkspaceDir, "hello.txt").writeText("hello from kmp e2e\n")

        val baseBridge = createPlatformHostBridge()
        val isolatedBridge = object : ai.yetanother.deskfleet.platform.HostBridge by baseBridge {
            override fun readPersistedState(fileName: String): String? {
                val f = File(tempStateDir, fileName)
                return if (f.isFile) f.readText() else null
            }

            override fun writePersistedState(fileName: String, content: String) {
                File(tempStateDir, fileName).writeText(content)
            }
        }

        val controllerScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val controller = AppController(
            scope = controllerScope,
            hostBridge = isolatedBridge,
            daemonDirOverride = daemonDir,
        )

        try {
            // 1. Real Login + PKCE Bearer Upgrade + `/api/client/ws` Realtime WebSocket
            val user = controller.signInWithPassword(serverUrl, email, password)
            assertEquals(email, user.email)
            assertTrue(controller.central.account.value.token?.isNotBlank() == true, "Expected upgraded Bearer token")

            withTimeout(10_000L) {
                while (!controller.central.wsConnected.value) delay(100L)
            }

            // 2. Real Team Creation + Local Daemon IPC Enrollment
            val team = controller.createTeam("KMP E2E Team")
            assertEquals(team.id, controller.selectedTeamId.value)

            val daemonStatus = isolatedBridge.queryLocalDaemonStatus(daemonDir)
            assertTrue(daemonStatus.available, "Expected local daemon IPC socket to be reachable: ${daemonStatus.error}")

            val enrolledMachine = controller.enrollThisComputer("KMP Test Mac")
            val mScope = MachineScope(team.id, enrolledMachine.id)
            val runtime = controller.runtimeFor(mScope, enrolledMachine)

            withTimeout(15_000L) {
                while (!runtime.machine.value.online) {
                    controller.refreshMachinesForTeam(team.id)
                    delay(250L)
                }
            }

            // 3. Real Workspace Creation + Catalog Sync
            val ws = runtime.createWorkspace("SampleRepo", listOf(sampleWorkspaceDir.absolutePath))
            assertTrue(ws.id.isNotBlank())
            runtime.refreshCatalog()
            assertTrue(runtime.catalog.value.workspaces.any { it.id == ws.id })

            // 4. Real Interactive PTY Terminal (Local Daemon IPC / WebRTC)
            val termSession = runtime.dialNewTerminal(cwd = sampleWorkspaceDir.absolutePath)
            withTimeout(10_000L) {
                while (!termSession.ready.value) delay(100L)
            }
            val marker = "KMP_PTY_LIVE_${System.currentTimeMillis()}"
            termSession.sendUserText("echo $marker\r")
            withTimeout(10_000L) {
                while (termSession.emulator.findMatches(marker).isEmpty()) {
                    delay(100L)
                }
            }
            runtime.hangupTerminal(termSession.terminalId)

            // 5. Real WebRTC `fixed4-v1` 4-Lane Mux File Listing + Upload + Download via Rust Bridge!
            runtime.browseRemote(sampleWorkspaceDir.absolutePath)
            val remoteList = runtime.remoteFileListing.value
            assertNotNull(remoteList)
            assertTrue(remoteList.entries.any { it.name == "hello.txt" })

            val filesClient = runtime.ensureFilesClient()
            val payloadBytes = ("Uploaded via KMP fixed4-v1 WebRTC Mux! ".repeat(4000)).encodeToByteArray()
            val uploadedPath = filesClient.uploadFileBytes(
                destinationDirectory = sampleWorkspaceDir.absolutePath,
                fileName = "uploaded-via-webrtc.txt",
                bytes = payloadBytes,
                conflict = FileConflictPolicy.REPLACE,
            )
            val downloadedBytes = filesClient.readAllBytes(uploadedPath)
            assertContentEquals(payloadBytes, downloadedBytes)

            // 6. Real System Status Telemetry & Scheduled Task RPCs
            runtime.startSystemStatusPolling()
            withTimeout(10_000L) {
                while (runtime.systemStatus.value == null) delay(150L)
            }
            assertTrue((runtime.systemStatus.value?.cpuCores ?: 0) >= 1)
            runtime.stopSystemStatusPolling()

            val providerObj = controller.central.rpc(
                team.id,
                enrolledMachine.id,
                "providerCreate",
                buildJsonObject {
                    put("provider", buildJsonObject {
                        put("template", "codex")
                        put("name", "KMP E2E Provider")
                        put("env", buildJsonObject {})
                    })
                },
            ).jsonObject
            val providerId = providerObj["id"]!!.jsonPrimitive.content

            val createdSchedule = runtime.createSchedule(
                ScheduleInputWire(
                    title = "KMP Nightly Check",
                    prompt = "Check status",
                    workspaceId = ws.id,
                    enabled = false,
                    target = ScheduleTargetWire(kind = "new", provider = providerId, context = "directory"),
                    trigger = ScheduleTriggerWire(kind = "manual"),
                )
            )
            assertTrue(runtime.schedules.value.any { it.id == createdSchedule.id })
            runtime.deleteSchedule(createdSchedule.id)
        } finally {
            controller.dispose()
            tempStateDir.deleteRecursively()
            sampleWorkspaceDir.deleteRecursively()
        }
    }
}
