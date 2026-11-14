package ai.yetanother.deskfleet.ui.remote

import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.state.AppController
import ai.yetanother.deskfleet.state.PaneTab
import ai.yetanother.deskfleet.state.SystemChartSample
import ai.yetanother.deskfleet.ui.common.*
import ai.yetanother.deskfleet.ui.theme.LocalDeskFleetColors
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.isSecondaryPressed
import androidx.compose.ui.input.pointer.isTertiaryPressed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

/**
 * Live WebRTC Remote Desktop View (`DesktopView.vue`):
 * - Decodes & renders live H.264 video frames via `NativeRtcBridge` + `bgraFrameToImageBitmap`.
 * - Forwards normalized `[0, 1]` pointer move/buttons, wheel, keyboard codes, and `Ctrl+Alt+Del` (`secureAttention`).
 * - Includes draggable floating HUD + `"Native Viewer"` launcher on Desktop (`supportsNativeDesktopViewer`).
 */
@Composable
fun RemoteDesktopView(
    controller: AppController,
    machineScope: MachineScope,
) {
    val palette = LocalDeskFleetColors.current
    val runtime = remember(machineScope) { controller.runtimeFor(machineScope) }
    val desktop = runtime.desktopSession
    val caps by runtime.desktopCapabilities.collectAsState()
    val connected by desktop.connected.collectAsState()
    val frame by desktop.latestFrame.collectAsState()
    val controlEnabled by desktop.controlEnabled.collectAsState()
    val selectedDisplayId by desktop.selectedDisplayId.collectAsState()
    val errorText by desktop.error.collectAsState()
    val machine by runtime.machine.collectAsState()

    var connecting by remember { mutableStateOf(false) }
    var stageSize by remember { mutableStateOf(IntSize(1, 1)) }
    var hudOffsetX by remember { mutableFloatStateOf(0f) }
    var hudOffsetY by remember { mutableFloatStateOf(14f) }
    val focusRequester = remember { FocusRequester() }
    val scope = rememberCoroutineScope()

    DisposableEffect(machineScope) {
        scope.launch {
            connecting = true
            runCatching { runtime.startEmbeddedDesktop(control = true) }
            connecting = false
        }
        onDispose {
            desktop.stop()
        }
    }

    val bitmap = remember(frame?.seq) {
        frame?.let { runCatching { bgraFrameToImageBitmap(it) }.getOrNull() }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.desktopStage)
            .onSizeChanged { stageSize = it }
            .focusRequester(focusRequester)
            .focusable()
            .onPreviewKeyEvent { ev ->
                if (!connected || !controlEnabled) return@onPreviewKeyEvent false
                val domCode = mapComposeKeyToDomCode(ev.key) ?: return@onPreviewKeyEvent false
                val pressed = ev.type == KeyEventType.KeyDown
                scope.launch { desktop.sendKey(domCode, pressed) }
                true
            }
            .pointerInput(connected, controlEnabled, stageSize) {
                if (!connected || !controlEnabled) return@pointerInput
                awaitPointerEventScope {
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull() ?: continue
                        val nx = (change.position.x / stageSize.width.coerceAtLeast(1).toFloat()).toDouble().coerceIn(0.0, 1.0)
                        val ny = (change.position.y / stageSize.height.coerceAtLeast(1).toFloat()).toDouble().coerceIn(0.0, 1.0)
                        when (event.type) {
                            PointerEventType.Move -> {
                                scope.launch { desktop.sendPointerMove(nx, ny) }
                            }
                            PointerEventType.Press -> {
                                runCatching { focusRequester.requestFocus() }
                                val btn = when {
                                    event.buttons.isSecondaryPressed -> 2
                                    event.buttons.isTertiaryPressed -> 1
                                    else -> 0
                                }
                                scope.launch { desktop.sendPointerButton(btn, true, nx, ny) }
                            }
                            PointerEventType.Release -> {
                                scope.launch { desktop.sendPointerButton(0, false, nx, ny) }
                            }
                            PointerEventType.Scroll -> {
                                val delta = change.scrollDelta
                                scope.launch { desktop.sendWheel(delta.x * 40.0, delta.y * 40.0) }
                            }
                        }
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap != null) {
            Image(
                bitmap = bitmap,
                contentDescription = "${machine.name} Remote Display",
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.padding(24.dp),
            ) {
                Text(
                    text = when {
                        connecting -> "Negotiating WebRTC H.264 stream with ${machine.name}…"
                        !errorText.isNullOrEmpty() -> "Remote desktop unavailable"
                        connected -> "Waiting for first keyframe from ${machine.name}…"
                        else -> "Disconnected from ${machine.name}"
                    },
                    color = Color.White.copy(alpha = 0.85f),
                    fontSize = 14.sp,
                )
                if (!errorText.isNullOrEmpty()) {
                    ErrorNotice(message = errorText!!, modifier = Modifier.widthIn(max = 460.dp))
                }
                if (!connecting) {
                    UiButton(
                        text = "Reconnect Stream",
                        variant = ButtonVariant.PRIMARY,
                        onClick = {
                            scope.launch {
                                connecting = true
                                runCatching { runtime.startEmbeddedDesktop(control = controlEnabled) }
                                connecting = false
                            }
                        },
                    )
                }
            }
        }

        // Draggable Floating Desktop HUD Toolbar
        Row(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .offset { IntOffset(hudOffsetX.roundToInt(), hudOffsetY.roundToInt()) }
                .clip(RoundedCornerShape(999.dp))
                .background(palette.surfaceElevated.copy(alpha = 0.92f))
                .border(1.dp, palette.borderStrong, RoundedCornerShape(999.dp))
                .pointerInput(Unit) {
                    detectDragGestures { _, dragAmount ->
                        hudOffsetX += dragAmount.x
                        hudOffsetY = (hudOffsetY + dragAmount.y).coerceAtLeast(6f)
                    }
                }
                .padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            StatusDot(online = connected)
            Text(machine.name, color = palette.text, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)

            UiButton(
                text = if (controlEnabled) "Controlling" else "View Only",
                size = ButtonSize.SM,
                active = controlEnabled,
                onClick = { scope.launch { desktop.setControlEnabled(!controlEnabled) } },
            )

            if (caps.displays.size > 1) {
                caps.displays.forEachIndexed { idx, disp ->
                    UiButton(
                        text = "D${idx + 1}",
                        size = ButtonSize.SM,
                        active = selectedDisplayId == disp.id || (selectedDisplayId == null && idx == 0),
                        onClick = { scope.launch { desktop.selectDisplay(disp) } },
                    )
                }
            }

            if (caps.secureAttention || machine.os == "win32") {
                UiButton(
                    text = "Ctrl+Alt+Del",
                    size = ButtonSize.SM,
                    onClick = { scope.launch { desktop.sendSecureAttention() } },
                )
            }

            if (controller.hostBridge.platform.supportsNativeDesktopViewer) {
                UiButton(
                    text = "Native Window",
                    size = ButtonSize.SM,
                    onClick = { scope.launch { runtime.launchNativeViewer(controlEnabled) } },
                )
            }
        }
    }
}

/**
 * Fleet-wide Remote Desktops Grid (`RemoteDesktopsView.vue`).
 */
@Composable
fun RemoteDesktopsGridView(controller: AppController) {
    val palette = LocalDeskFleetColors.current
    val selectedTeamId by controller.selectedTeamId.collectAsState()
    val machines = controller.currentTeamMachines()
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier.fillMaxSize().background(palette.canvas).padding(22.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Remote Desktops", color = palette.text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text(
            "Connect to any online workstation's display via low-latency WebRTC H.264.",
            color = palette.textMuted,
            fontSize = 13.sp,
        )
        if (machines.isEmpty() || selectedTeamId == null) {
            Text("No machines enrolled in this Team yet.", color = palette.textFaint, fontSize = 13.5.sp)
        } else {
            Column(
                modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                machines.chunked(2).forEach { pair ->
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                        pair.forEach { m ->
                            val mScope = MachineScope(selectedTeamId!!, m.id)
                            val shape = RoundedCornerShape(12.dp)
                            Column(
                                modifier = Modifier
                                    .weight(1f)
                                    .clip(shape)
                                    .background(palette.surface)
                                    .border(1.dp, palette.border, shape)
                                    .padding(16.dp),
                                verticalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    StatusDot(online = m.online)
                                    Text(m.name, color = palette.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                                    Text("${m.os}/${m.arch}", color = palette.textFaint, fontSize = 11.5.sp, fontFamily = FontFamily.Monospace)
                                }
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    UiButton(
                                        text = "Open Embedded",
                                        size = ButtonSize.SM,
                                        variant = ButtonVariant.PRIMARY,
                                        enabled = m.online,
                                        onClick = { controller.openTab(PaneTab.RemoteDesktop(mScope, "${m.name} Desktop")) },
                                    )
                                    if (controller.hostBridge.platform.supportsNativeDesktopViewer) {
                                        UiButton(
                                            text = "Native Viewer",
                                            size = ButtonSize.SM,
                                            enabled = m.online,
                                            onClick = {
                                                scope.launch { controller.runtimeFor(mScope, m).launchNativeViewer(true) }
                                            },
                                        )
                                    }
                                }
                            }
                        }
                        if (pair.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

/**
 * Two-Pane Local <-> Machine File Explorer & Transfer Queue (`FileTransferPanel.vue`).
 */
@Composable
fun FileTransferPanelView(
    controller: AppController,
    machineScope: MachineScope,
    isMobileLayout: Boolean,
) {
    val palette = LocalDeskFleetColors.current
    val runtime = remember(machineScope) { controller.runtimeFor(machineScope) }
    val machine by runtime.machine.collectAsState()
    val localListing by runtime.localFileListing.collectAsState()
    val remoteListing by runtime.remoteFileListing.collectAsState()
    val transfers by runtime.transfers.collectAsState()
    val scope = rememberCoroutineScope()

    var showHidden by remember { mutableStateOf(false) }
    var conflictPolicy by remember { mutableStateOf(FileConflictPolicy.RENAME) }
    var mobilePaneTab by remember { mutableStateOf("remote") }
    var errorMsg by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(machineScope) {
        runCatching { runtime.browseLocal(null) }.onFailure { errorMsg = it.message }
        runCatching { runtime.browseRemote(null) }.onFailure { errorMsg = it.message }
    }

    Column(modifier = Modifier.fillMaxSize().background(palette.canvas).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("File Browser — ${machine.name}", color = palette.text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                UiCheckbox(checked = showHidden, onCheckedChange = { showHidden = it }, label = "Dotfiles")
                UiSelect(
                    options = listOf(
                        SelectOption(FileConflictPolicy.RENAME, "On conflict: Keep both"),
                        SelectOption(FileConflictPolicy.REPLACE, "On conflict: Replace"),
                        SelectOption(FileConflictPolicy.SKIP, "On conflict: Skip"),
                    ),
                    selected = conflictPolicy,
                    onSelected = { conflictPolicy = it },
                    modifier = Modifier.width(195.dp),
                )
            }
        }

        if (!errorMsg.isNullOrEmpty()) ErrorNotice(message = errorMsg!!, onDismiss = { errorMsg = null })

        if (isMobileLayout) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                UiButton("Local Device", size = ButtonSize.SM, active = mobilePaneTab == "local", onClick = { mobilePaneTab = "local" })
                UiButton(machine.name, size = ButtonSize.SM, active = mobilePaneTab == "remote", onClick = { mobilePaneTab = "remote" })
            }
            if (mobilePaneTab == "local") {
                FilePaneCard(
                    title = "This Device",
                    listing = localListing,
                    showHidden = showHidden,
                    actionLabel = "Upload →",
                    onNavigate = { p -> scope.launch { runCatching { runtime.browseLocal(p) }.onFailure { errorMsg = it.message } } },
                    onTransferEntry = { entry ->
                        val dest = remoteListing?.path ?: return@FilePaneCard
                        runtime.enqueueUpload(entry, dest, conflictPolicy)
                    },
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
            } else {
                FilePaneCard(
                    title = machine.name,
                    listing = remoteListing,
                    showHidden = showHidden,
                    actionLabel = "← Download",
                    onNavigate = { p -> scope.launch { runCatching { runtime.browseRemote(p) }.onFailure { errorMsg = it.message } } },
                    onTransferEntry = { entry ->
                        val dest = localListing?.path ?: return@FilePaneCard
                        runtime.enqueueDownload(entry, dest, conflictPolicy)
                    },
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
            }
        } else {
            Row(modifier = Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                FilePaneCard(
                    title = "Local (${controller.hostBridge.platform.hostname})",
                    listing = localListing,
                    showHidden = showHidden,
                    actionLabel = "Upload →",
                    onNavigate = { p -> scope.launch { runCatching { runtime.browseLocal(p) }.onFailure { errorMsg = it.message } } },
                    onTransferEntry = { entry ->
                        val dest = remoteListing?.path ?: return@FilePaneCard
                        runtime.enqueueUpload(entry, dest, conflictPolicy)
                    },
                    modifier = Modifier.weight(1f).fillMaxHeight(),
                )
                FilePaneCard(
                    title = "Remote (${machine.name})",
                    listing = remoteListing,
                    showHidden = showHidden,
                    actionLabel = "← Download",
                    onNavigate = { p -> scope.launch { runCatching { runtime.browseRemote(p) }.onFailure { errorMsg = it.message } } },
                    onTransferEntry = { entry ->
                        val dest = localListing?.path ?: return@FilePaneCard
                        runtime.enqueueDownload(entry, dest, conflictPolicy)
                    },
                    modifier = Modifier.weight(1f).fillMaxHeight(),
                )
            }
        }

        // Active & Recent Transfer Queue
        if (transfers.isNotEmpty()) {
            val qShape = RoundedCornerShape(10.dp)
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 150.dp)
                    .clip(qShape)
                    .background(palette.surface)
                    .border(1.dp, palette.border, qShape)
                    .padding(10.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("Transfers (${transfers.size})", color = palette.textMuted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                transfers.forEach { xfer ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(xfer.name, color = palette.text, fontSize = 12.5.sp, maxLines = 1, modifier = Modifier.weight(1f))
                        val pct = if ((xfer.totalBytes ?: 0L) > 0L) {
                            (xfer.transferredBytes.toFloat() / xfer.totalBytes!!.toFloat()).coerceIn(0f, 1f)
                        } else 0f
                        if (xfer.state == "transferring") {
                            LinearProgressIndicator(progress = { pct }, modifier = Modifier.width(90.dp).height(5.dp))
                            UiButton("Cancel", size = ButtonSize.SM, onClick = { runtime.cancelTransfer(xfer.id) })
                        } else {
                            Text(xfer.state, color = if (xfer.state == "completed") palette.success else palette.warning, fontSize = 11.5.sp)
                            if (xfer.state == "failed" || xfer.state == "conflict") {
                                UiButton("Replace", size = ButtonSize.SM, onClick = { runtime.retryTransfer(xfer.id, FileConflictPolicy.REPLACE) })
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FilePaneCard(
    title: String,
    listing: FileListing?,
    showHidden: Boolean,
    actionLabel: String,
    onNavigate: (String?) -> Unit,
    onTransferEntry: (FileEntry) -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalDeskFleetColors.current
    val shape = RoundedCornerShape(11.dp)
    Column(
        modifier = modifier
            .clip(shape)
            .background(palette.surface)
            .border(1.dp, palette.border, shape)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Text(title, color = palette.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (listing?.parent != null) {
                    UiButton("↑ Up", size = ButtonSize.SM, onClick = { onNavigate(listing.parent) })
                }
                UiButton("↻", size = ButtonSize.SM, onClick = { onNavigate(listing?.path) })
            }
        }
        Text(
            text = listing?.path ?: "Loading…",
            color = palette.textMuted,
            fontSize = 11.5.sp,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Column(modifier = Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
            val entries = listing?.entries.orEmpty().filter { showHidden || !it.hidden }
            entries.forEach { entry ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .clickable {
                            if (entry.kind == "directory") onNavigate(entry.path)
                        }
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(if (entry.kind == "directory") "📁" else "📄", fontSize = 13.sp)
                    Text(entry.name, color = palette.text, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    if (entry.kind == "file") {
                        Text(formatByteSize(entry.size), color = palette.textFaint, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                        UiButton(actionLabel, size = ButtonSize.SM, onClick = { onTransferEntry(entry) })
                    }
                }
            }
        }
    }
}

/**
 * Live 2s Machine Telemetry & Dual-Series Chart (`SystemStatusPanel.vue`).
 */
@Composable
fun SystemStatusPanelView(
    controller: AppController,
    machineScope: MachineScope,
) {
    val palette = LocalDeskFleetColors.current
    val runtime = remember(machineScope) { controller.runtimeFor(machineScope) }
    val status by runtime.systemStatus.collectAsState()
    val history by runtime.systemHistory.collectAsState()
    val machine by runtime.machine.collectAsState()

    DisposableEffect(machineScope) {
        runtime.startSystemStatusPolling()
        onDispose { runtime.stopSystemStatusPolling() }
    }

    Column(
        modifier = Modifier.fillMaxSize().background(palette.canvas).verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("${machine.name} — System Status", color = palette.text, fontSize = 19.sp, fontWeight = FontWeight.Bold)
        val cur = status
        if (cur == null) {
            Text("Sampling machine telemetry…", color = palette.textMuted, fontSize = 13.sp)
            return@Column
        }

        // Summary KPI Cards
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
            MetricCard("CPU", "${((cur.cpuUsagePercent * 10).roundToInt() / 10.0)}%", "${cur.cpuCores} cores · ${cur.cpuModel}", Modifier.weight(1f))
            MetricCard("Memory", "${formatByteSize(cur.memoryUsedBytes)} / ${formatByteSize(cur.memoryTotalBytes)}", "Swap: ${formatByteSize(cur.swapUsedBytes)}", Modifier.weight(1f))
            MetricCard("Network", "↓ ${formatByteSize(cur.rxBytesPerSec)}/s", "↑ ${formatByteSize(cur.txBytesPerSec)}/s", Modifier.weight(1f))
        }

        // Dual-series CPU & Memory 60-sample Chart
        DualSeriesTelemetryChart(samples = history)

        // Disks
        if (cur.disks.isNotEmpty()) {
            val shape = RoundedCornerShape(12.dp)
            Column(
                modifier = Modifier.fillMaxWidth().clip(shape).background(palette.surface).border(1.dp, palette.border, shape).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Storage Volumes", color = palette.text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                cur.disks.forEach { d ->
                    val frac = if (d.totalBytes > 0) (d.usedBytes.toFloat() / d.totalBytes.toFloat()).coerceIn(0f, 1f) else 0f
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(d.mountPoint, color = palette.text, fontSize = 12.5.sp, fontFamily = FontFamily.Monospace)
                            Text("${formatByteSize(d.usedBytes)} / ${formatByteSize(d.totalBytes)}", color = palette.textMuted, fontSize = 12.sp)
                        }
                        LinearProgressIndicator(progress = { frac }, modifier = Modifier.fillMaxWidth().height(6.dp), color = palette.accent, trackColor = palette.control)
                    }
                }
            }
        }
    }
}

@Composable
private fun MetricCard(title: String, primary: String, subtitle: String, modifier: Modifier = Modifier) {
    val palette = LocalDeskFleetColors.current
    val shape = RoundedCornerShape(12.dp)
    Column(
        modifier = modifier.clip(shape).background(palette.surface).border(1.dp, palette.border, shape).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(title, color = palette.textMuted, fontSize = 12.sp)
        Text(primary, color = palette.text, fontSize = 18.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
        Text(subtitle, color = palette.textFaint, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun DualSeriesTelemetryChart(samples: List<SystemChartSample>) {
    val palette = LocalDeskFleetColors.current
    val shape = RoundedCornerShape(12.dp)
    Column(
        modifier = Modifier.fillMaxWidth().clip(shape).background(palette.surface).border(1.dp, palette.border, shape).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("● CPU %", color = palette.accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            Text("● Memory %", color = palette.success, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        }
        Canvas(modifier = Modifier.fillMaxWidth().height(150.dp)) {
            if (samples.size < 2) return@Canvas
            val cpuPath = Path()
            val memPath = Path()
            val stepX = size.width / (samples.size - 1).coerceAtLeast(1)
            samples.forEachIndexed { idx, s ->
                val x = idx * stepX
                val yCpu = size.height * (1f - (s.cpuPercent / 100f).coerceIn(0f, 1f))
                val yMem = size.height * (1f - (s.memoryPercent / 100f).coerceIn(0f, 1f))
                if (idx == 0) {
                    cpuPath.moveTo(x, yCpu)
                    memPath.moveTo(x, yMem)
                } else {
                    cpuPath.lineTo(x, yCpu)
                    memPath.lineTo(x, yMem)
                }
            }
            drawLine(palette.border, Offset(0f, size.height * 0.5f), Offset(size.width, size.height * 0.5f), 1f)
            drawPath(cpuPath, color = palette.accent, style = Stroke(width = 2.5f))
            drawPath(memPath, color = palette.success, style = Stroke(width = 2.5f))
        }
    }
}

internal fun formatByteSize(bytes: Long): String {
    if (bytes < 1024L) return "$bytes B"
    val kb = bytes / 1024.0
    if (kb < 1024.0) return "${(kb * 10).roundToInt() / 10.0} KB"
    val mb = kb / 1024.0
    if (mb < 1024.0) return "${(mb * 10).roundToInt() / 10.0} MB"
    val gb = mb / 1024.0
    return "${(gb * 10).roundToInt() / 10.0} GB"
}

private fun mapComposeKeyToDomCode(key: Key): String? = when (key) {
    Key.A -> "KeyA"; Key.B -> "KeyB"; Key.C -> "KeyC"; Key.D -> "KeyD"; Key.E -> "KeyE"
    Key.F -> "KeyF"; Key.G -> "KeyG"; Key.H -> "KeyH"; Key.I -> "KeyI"; Key.J -> "KeyJ"
    Key.K -> "KeyK"; Key.L -> "KeyL"; Key.M -> "KeyM"; Key.N -> "KeyN"; Key.O -> "KeyO"
    Key.P -> "KeyP"; Key.Q -> "KeyQ"; Key.R -> "KeyR"; Key.S -> "KeyS"; Key.T -> "KeyT"
    Key.U -> "KeyU"; Key.V -> "KeyV"; Key.W -> "KeyW"; Key.X -> "KeyX"; Key.Y -> "KeyY"; Key.Z -> "KeyZ"
    Key.Zero -> "Digit0"; Key.One -> "Digit1"; Key.Two -> "Digit2"; Key.Three -> "Digit3"; Key.Four -> "Digit4"
    Key.Five -> "Digit5"; Key.Six -> "Digit6"; Key.Seven -> "Digit7"; Key.Eight -> "Digit8"; Key.Nine -> "Digit9"
    Key.Enter -> "Enter"; Key.Escape -> "Escape"; Key.Backspace -> "Backspace"; Key.Tab -> "Tab"; Key.Spacebar -> "Space"
    Key.DirectionUp -> "ArrowUp"; Key.DirectionDown -> "ArrowDown"; Key.DirectionLeft -> "ArrowLeft"; Key.DirectionRight -> "ArrowRight"
    Key.ShiftLeft -> "ShiftLeft"; Key.ShiftRight -> "ShiftRight"; Key.CtrlLeft -> "ControlLeft"; Key.CtrlRight -> "ControlRight"
    Key.AltLeft -> "AltLeft"; Key.AltRight -> "AltRight"; Key.MetaLeft -> "MetaLeft"; Key.MetaRight -> "MetaRight"
    else -> null
}
