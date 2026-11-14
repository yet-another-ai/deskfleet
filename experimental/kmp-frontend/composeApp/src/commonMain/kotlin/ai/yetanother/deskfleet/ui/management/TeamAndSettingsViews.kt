package ai.yetanother.deskfleet.ui.management

import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.state.AppController
import ai.yetanother.deskfleet.ui.common.*
import ai.yetanother.deskfleet.ui.remote.formatByteSize
import ai.yetanother.deskfleet.ui.theme.LocalDeskFleetColors
import ai.yetanother.deskfleet.ui.theme.SUPPORTED_LOCALES
import ai.yetanother.deskfleet.ui.theme.TERMINAL_THEMES
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/**
 * Team Settings, Members, Plans/Usage & AI Usage View (`TeamSettingsView.vue` + `TeamAiUsageSection.vue`).
 * - Desktop (`!suppressBillingPricing`): Shows `"Plans & Billing"` with Stripe Checkout & Customer Portal.
 * - Mobile (`suppressBillingPricing`): Shows read-only `"Usage"` limits with zero pricing/checkout links!
 */
@Composable
fun TeamSettingsView(
    controller: AppController,
    initialSection: String = "members",
) {
    val palette = LocalDeskFleetColors.current
    val suppressPricing = controller.hostBridge.platform.suppressBillingPricing
    val selectedTeamId by controller.selectedTeamId.collectAsState()
    val teams by controller.teams.collectAsState()
    val members by controller.teamMembers.collectAsState()
    val billing by controller.teamBilling.collectAsState()
    val aiUsage by controller.teamAiUsage.collectAsState()
    val scope = rememberCoroutineScope()

    var section by remember(initialSection) { mutableStateOf(initialSection) }
    var inviteEmail by remember { mutableStateOf("") }
    var inviteRole by remember { mutableStateOf("member") }
    var lastInviteToken by remember { mutableStateOf<String?>(null) }
    var aiPeriod by remember { mutableStateOf("30d") }
    var errorMsg by remember { mutableStateOf<String?>(null) }

    val currentTeam = teams.firstOrNull { it.id == selectedTeamId }

    LaunchedEffect(selectedTeamId) {
        selectedTeamId?.let { controller.refreshTeamDetails(it) }
    }

    Column(
        modifier = Modifier.fillMaxSize().background(palette.canvas).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(currentTeam?.name ?: "Team Settings", color = palette.text, fontSize = 20.sp, fontWeight = FontWeight.Bold)

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            UiButton("Members", size = ButtonSize.SM, active = section == "members", onClick = { section = "members" })
            UiButton(
                text = if (suppressPricing) "Usage" else "Plans & Billing",
                size = ButtonSize.SM,
                active = section == "billing",
                onClick = { section = "billing" },
            )
            UiButton("AI Usage", size = ButtonSize.SM, active = section == "ai", onClick = { section = "ai" })
        }

        if (!errorMsg.isNullOrEmpty()) ErrorNotice(message = errorMsg!!, onDismiss = { errorMsg = null })

        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            when (section) {
                "members" -> {
                    val cardShape = RoundedCornerShape(12.dp)
                    Column(
                        modifier = Modifier.fillMaxWidth().clip(cardShape).background(palette.surface).border(1.dp, palette.border, cardShape).padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text("Invite Member", color = palette.text, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
                            UiField(value = inviteEmail, onValueChange = { inviteEmail = it }, label = "Email", placeholder = "teammate@example.com", modifier = Modifier.weight(1f))
                            UiSelect(
                                label = "Role",
                                options = listOf(SelectOption("member", "Member"), SelectOption("admin", "Admin")),
                                selected = inviteRole,
                                onSelected = { inviteRole = it },
                                modifier = Modifier.width(130.dp),
                            )
                            UiButton(
                                text = "Create Invite",
                                variant = ButtonVariant.PRIMARY,
                                enabled = inviteEmail.isNotBlank() && selectedTeamId != null,
                                onClick = {
                                    scope.launch {
                                        runCatching {
                                            val obj = controller.central.inviteMember(selectedTeamId!!, inviteEmail, inviteRole)
                                            lastInviteToken = obj["token"]?.jsonPrimitive?.contentOrNull
                                            inviteEmail = ""
                                        }.onFailure { errorMsg = it.message }
                                    }
                                },
                            )
                        }
                        if (!lastInviteToken.isNullOrBlank()) {
                            CopyField(
                                label = "Share this invite token:",
                                value = lastInviteToken!!,
                                onCopy = { controller.hostBridge.copyToClipboard(it) },
                            )
                        }
                    }

                    members.forEach { m ->
                        val mShape = RoundedCornerShape(10.dp)
                        Row(
                            modifier = Modifier.fillMaxWidth().clip(mShape).background(palette.surface).border(1.dp, palette.border, mShape).padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            UserAvatar(m.name, m.email)
                            Column(Modifier.weight(1f)) {
                                Text(m.name.ifBlank { m.email }, color = palette.text, fontSize = 13.5.sp, fontWeight = FontWeight.Medium)
                                Text("${m.email} · ${m.role}", color = palette.textMuted, fontSize = 12.sp)
                            }
                            if (m.role != "owner" && selectedTeamId != null) {
                                UiButton(
                                    text = "Remove",
                                    size = ButtonSize.SM,
                                    variant = ButtonVariant.DANGER,
                                    onClick = {
                                        scope.launch {
                                            runCatching {
                                                controller.central.removeMember(selectedTeamId!!, m.userId)
                                                controller.refreshTeamDetails(selectedTeamId!!)
                                            }.onFailure { errorMsg = it.message }
                                        }
                                    },
                                )
                            }
                        }
                    }
                }

                "billing" -> {
                    val b = billing
                    if (b == null) {
                        Text("Loading usage…", color = palette.textMuted)
                    } else {
                        val cardShape = RoundedCornerShape(12.dp)
                        Column(
                            modifier = Modifier.fillMaxWidth().clip(cardShape).background(palette.surface).border(1.dp, palette.border, cardShape).padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text("Current Plan: ${b.plan.uppercase()}", color = palette.text, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                            Text("Active Sessions: ${b.usage.activeSessionCount} / ${b.limits.maxActiveSessions ?: "∞"}", color = palette.textMuted, fontSize = 13.sp)
                            Text("Team Members: ${b.usage.memberCount} / ${b.limits.maxMembers ?: "∞"}", color = palette.textMuted, fontSize = 13.sp)
                            Text("TURN Relayed Bytes: ${b.usage.relayedBytes}", color = palette.textMuted, fontSize = 13.sp)

                            // Strictly suppressed on iOS/Android per Capacitor mobile store policy!
                            if (!suppressPricing && selectedTeamId != null) {
                                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 8.dp)) {
                                    if (b.paymentsAvailable && b.plan == "free") {
                                        UiButton(
                                            text = "Upgrade to Pro",
                                            variant = ButtonVariant.PRIMARY,
                                            onClick = {
                                                scope.launch {
                                                    runCatching {
                                                        val idemKey = "req-${kotlin.random.Random.nextLong(100_000_000_000L, 999_999_999_999L)}"
                                                        val url = controller.central.billingCheckoutUrl(selectedTeamId!!, "pro", idemKey)
                                                        controller.hostBridge.openExternalUrl(url)
                                                    }.onFailure { errorMsg = it.message }
                                                }
                                            },
                                        )
                                    }
                                    if (b.subscription != null) {
                                        UiButton(
                                            text = "Open Billing Portal",
                                            onClick = {
                                                scope.launch {
                                                    runCatching {
                                                        val url = controller.central.billingPortalUrl(selectedTeamId!!)
                                                        controller.hostBridge.openExternalUrl(url)
                                                    }.onFailure { errorMsg = it.message }
                                                }
                                            },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }

                "ai" -> {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("7d", "30d", "90d").forEach { p ->
                            UiButton(
                                text = p,
                                size = ButtonSize.SM,
                                active = aiPeriod == p,
                                onClick = {
                                    aiPeriod = p
                                    scope.launch { runCatching { controller.loadAiUsage(p) } }
                                },
                            )
                        }
                    }
                    val u = aiUsage
                    if (u != null) {
                        val shape = RoundedCornerShape(12.dp)
                        Column(
                            modifier = Modifier.fillMaxWidth().clip(shape).background(palette.surface).border(1.dp, palette.border, shape).padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Text("Total Tokens (${u.period}): ${u.totals.totalTokens}", color = palette.text, fontSize = 16.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                            Text("Input: ${u.totals.inputTokens} · Output: ${u.totals.outputTokens} · Turns: ${u.totals.turnCount}", color = palette.textMuted, fontSize = 12.5.sp)

                            // Activity Heatmap Strip (`TeamAiUsageSection.vue`)
                            if (u.heatmap.isNotEmpty()) {
                                val maxTok = u.heatmap.maxOfOrNull { it.totalTokens }?.coerceAtLeast(1L) ?: 1L
                                Row(
                                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                                ) {
                                    u.heatmap.takeLast(84).forEach { day ->
                                        val intensity = (day.totalTokens.toFloat() / maxTok.toFloat()).coerceIn(0.08f, 1f)
                                        Box(
                                            modifier = Modifier
                                                .size(11.dp)
                                                .clip(RoundedCornerShape(2.dp))
                                                .background(if (day.totalTokens == 0L) palette.control else palette.accent.copy(alpha = intensity))
                                        )
                                    }
                                }
                            }

                            if (u.models.isNotEmpty()) {
                                Text("By Model", color = palette.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                                u.models.forEach { grp ->
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                        Text(grp.name, color = palette.text, fontSize = 12.5.sp, fontFamily = FontFamily.Monospace)
                                        Text("${grp.totalTokens} tok (${grp.turnCount} turns)", color = palette.textMuted, fontSize = 12.sp)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Multiplatform Settings View (`SettingsView.vue`) with platform-specific section visibility:
 * - Account, Appearance (OKLCH Hue + Dynamic Hue 36°/s + Locale), Terminal (5 presets + font size),
 *   Network & NAT (RFC 5780 STUN probe), MCP Servers CRUD, and Desktop Host controls.
 */
@Composable
fun SettingsView(
    controller: AppController,
    initialSection: String = "account",
) {
    val palette = LocalDeskFleetColors.current
    val platform = controller.hostBridge.platform
    val prefs by controller.preferences.collectAsState()
    val account by controller.central.account.collectAsState()
    val natResults by controller.natResults.collectAsState()
    val updateState by controller.updateState.collectAsState()
    val selectedTeamId by controller.selectedTeamId.collectAsState()
    val machines = controller.currentTeamMachines()
    val scope = rememberCoroutineScope()

    var section by remember(initialSection) { mutableStateOf(initialSection) }
    var natBusy by remember { mutableStateOf(false) }

    // MCP Server form state
    val firstMachineRuntime = remember(selectedTeamId, machines) {
        val m = machines.firstOrNull()
        if (selectedTeamId != null && m != null) controller.runtimeFor(MachineScope(selectedTeamId!!, m.id), m) else null
    }
    val mcpServers = firstMachineRuntime?.mcpServers?.collectAsState()?.value.orEmpty()
    var mcpName by remember { mutableStateOf("") }
    var mcpTransport by remember { mutableStateOf("stdio") }
    var mcpTarget by remember { mutableStateOf("") }
    var mcpError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(section, firstMachineRuntime) {
        if (section == "mcp") firstMachineRuntime?.refreshMcpServers()
    }

    Row(modifier = Modifier.fillMaxSize().background(palette.canvas)) {
        // Section Rail
        Column(
            modifier = Modifier.width(190.dp).fillMaxHeight().background(palette.sidebar).border(1.dp, palette.border).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text("Settings", color = palette.text, fontSize = 16.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(bottom = 6.dp))
            val tabs = buildList {
                add("account" to "Account")
                add("appearance" to "Appearance")
                add("terminal" to "Terminal")
                add("network" to "Network & NAT")
                add("mcp" to "MCP Servers")
                if (platform.isDesktop) add("desktop" to "Desktop Host")
            }
            tabs.forEach { (id, lbl) ->
                UiButton(
                    text = lbl,
                    variant = ButtonVariant.GHOST,
                    active = section == id,
                    fullWidth = true,
                    onClick = { section = id },
                )
            }
        }

        // Section Body
        Column(
            modifier = Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            when (section) {
                "account" -> {
                    Text("Account & Security", color = palette.text, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                    Text("Signed in as ${account.user?.email ?: "Unknown"} on ${account.serverUrl}", color = palette.textMuted, fontSize = 13.5.sp)
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        UiButton("Step-up Reauthenticate", onClick = { controller.setShowReauthDialog(true) })
                        UiButton("Sign out", variant = ButtonVariant.DANGER, onClick = { scope.launch { controller.signOut() } })
                    }
                }

                "appearance" -> {
                    Text("Appearance & Localization", color = palette.text, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                    UiSelect(
                        label = "Theme Mode",
                        options = listOf(
                            SelectOption("system", "System Default"),
                            SelectOption("dark", "Dark"),
                            SelectOption("light", "Light"),
                        ),
                        selected = prefs.themeMode,
                        onSelected = { mode -> controller.updatePreferences { it.copy(themeMode = mode) } },
                    )
                    UiSelect(
                        label = "Interface Language",
                        options = SUPPORTED_LOCALES.map { (code, name) -> SelectOption(code, name) },
                        selected = prefs.locale,
                        onSelected = { loc -> controller.updatePreferences { it.copy(locale = loc) } },
                    )
                    UiSwitch(
                        checked = prefs.customHueEnabled,
                        onCheckedChange = { en -> controller.updatePreferences { it.copy(customHueEnabled = en) } },
                        label = "Custom OKLCH Accent Hue",
                        description = "Perceptually uniform accent color across buttons, badges, and focus rings.",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (prefs.customHueEnabled) {
                        Text("Hue Angle: ${prefs.customHueDegrees.toInt()}°", color = palette.textMuted, fontSize = 12.5.sp)
                        Slider(
                            value = prefs.customHueDegrees,
                            onValueChange = { deg -> controller.updatePreferences { it.copy(customHueDegrees = deg) } },
                            valueRange = 0f..360f,
                        )
                        UiSwitch(
                            checked = prefs.dynamicHue,
                            onCheckedChange = { dyn -> controller.updatePreferences { it.copy(dynamicHue = dyn) } },
                            label = "Dynamic Hue Cycling (36°/s)",
                            description = "Smoothly rotates accent hue in real time.",
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }

                "terminal" -> {
                    Text("Terminal Emulator", color = palette.text, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                    UiSelect(
                        label = "Color Theme",
                        options = TERMINAL_THEMES.map { SelectOption(it.id, it.name) },
                        selected = prefs.terminalPreset,
                        onSelected = { preset -> controller.updatePreferences { it.copy(terminalPreset = preset) } },
                    )
                    UiNumberField(
                        value = prefs.terminalFontSizeSp.toInt(),
                        onValueChange = { sz -> controller.updatePreferences { it.copy(terminalFontSizeSp = sz.toFloat()) } },
                        label = "Font Size (sp)",
                        min = 10,
                        max = 26,
                    )
                }

                "network" -> {
                    Text("Network & RFC 5780 NAT Diagnostics", color = palette.text, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                    Text("Probes STUN mapping and filtering behavior through the native Rust WebRTC bridge.", color = palette.textMuted, fontSize = 13.sp)
                    UiButton(
                        text = "Run STUN NAT Probe",
                        variant = ButtonVariant.PRIMARY,
                        loading = natBusy,
                        onClick = {
                            scope.launch {
                                natBusy = true
                                runCatching { controller.runNatProbe() }
                                natBusy = false
                            }
                        },
                    )
                    natResults.forEach { r ->
                        val shape = RoundedCornerShape(10.dp)
                        Column(
                            modifier = Modifier.fillMaxWidth().clip(shape).background(palette.surface).border(1.dp, palette.border, shape).padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Text("${r.server} — ${r.status} (${r.durationMs}ms)", color = palette.text, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
                            Text("Local: ${r.localAddress} · Reflexive: ${r.publicAddress ?: "N/A"}", color = palette.textMuted, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                            Text("Mapping: ${r.mapping} · Filtering: ${r.filtering}", color = palette.accent, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                        }
                    }
                }

                "mcp" -> {
                    Text("MCP Servers", color = palette.text, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                    if (firstMachineRuntime == null) {
                        Text("Enroll an online Machine to manage its MCP servers.", color = palette.textFaint)
                    } else {
                        if (!mcpError.isNullOrEmpty()) ErrorNotice(message = mcpError!!)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
                            UiField(value = mcpName, onValueChange = { mcpName = it }, label = "Name", placeholder = "filesystem", modifier = Modifier.weight(0.8f))
                            UiSelect(
                                label = "Transport",
                                options = listOf(SelectOption("stdio", "stdio"), SelectOption("http", "http"), SelectOption("sse", "sse")),
                                selected = mcpTransport,
                                onSelected = { mcpTransport = it },
                                modifier = Modifier.width(110.dp),
                            )
                            UiField(
                                value = mcpTarget,
                                onValueChange = { mcpTarget = it },
                                label = if (mcpTransport == "stdio") "Executable Path" else "Server URL",
                                placeholder = if (mcpTransport == "stdio") "/usr/local/bin/mcp-server" else "https://example.com/mcp",
                                monospace = true,
                                modifier = Modifier.weight(1.4f),
                            )
                            UiButton(
                                text = "Add",
                                variant = ButtonVariant.PRIMARY,
                                enabled = mcpName.isNotBlank() && mcpTarget.isNotBlank(),
                                onClick = {
                                    scope.launch {
                                        mcpError = null
                                        val cfg = McpServerConfigWire(
                                            name = mcpName,
                                            transport = mcpTransport,
                                            command = if (mcpTransport == "stdio") mcpTarget else null,
                                            url = if (mcpTransport != "stdio") mcpTarget else null,
                                        )
                                        runCatching {
                                            firstMachineRuntime.upsertMcpServer(cfg)
                                            mcpName = ""
                                            mcpTarget = ""
                                        }.onFailure { mcpError = it.message }
                                    }
                                },
                            )
                        }
                        mcpServers.forEach { srv ->
                            Row(
                                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(9.dp)).background(palette.surface).border(1.dp, palette.border, RoundedCornerShape(9.dp)).padding(10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Column {
                                    Text("${srv.name} (${srv.transport})", color = palette.text, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
                                    Text(srv.command ?: srv.url.orEmpty(), color = palette.textMuted, fontSize = 11.5.sp, fontFamily = FontFamily.Monospace)
                                }
                                if (!srv.builtIn) {
                                    UiButton("Remove", size = ButtonSize.SM, variant = ButtonVariant.DANGER, onClick = {
                                        scope.launch { runCatching { firstMachineRuntime.removeMcpServer(srv.id) } }
                                    })
                                }
                            }
                        }
                    }
                }

                "desktop" -> {
                    Text("Desktop Host & Residency", color = palette.text, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                    UiSwitch(
                        checked = prefs.closeToTray,
                        onCheckedChange = { v -> controller.updatePreferences { it.copy(closeToTray = v) } },
                        label = "Keep running in system tray when window closes",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    UiSwitch(
                        checked = prefs.keepAwakeWhileWorking,
                        onCheckedChange = { v -> controller.updatePreferences { it.copy(keepAwakeWhileWorking = v) } },
                        label = "Prevent system sleep while an agent session is working",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        UiButton("Check for Updates", onClick = { scope.launch { controller.checkForUpdates() } })
                        Text("Version ${updateState.currentVersion} (${updateState.status})", color = palette.textMuted, fontSize = 12.5.sp)
                    }
                }
            }
        }
    }
}

/**
 * Site Administration View (`SiteAdminView.vue`) for `siteAdmin == true` operators.
 */
@Composable
fun SiteAdminView(controller: AppController) {
    val palette = LocalDeskFleetColors.current
    val scope = rememberCoroutineScope()
    var adminTeams by remember { mutableStateOf<List<AdminTeamBillingWire>>(emptyList()) }
    var searchQuery by remember { mutableStateOf("") }
    var registrationEnabled by remember { mutableStateOf(true) }
    var err by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching {
            val cfg = controller.central.fetchAuthConfig()
            registrationEnabled = cfg["registrationEnabled"]?.jsonPrimitive?.booleanOrNull != false
            adminTeams = controller.central.adminBillingTeams().teams
        }.onFailure { err = it.message }
    }

    Column(
        modifier = Modifier.fillMaxSize().background(palette.canvas).verticalScroll(rememberScrollState()).padding(22.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Site Administration", color = palette.text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        if (!err.isNullOrEmpty()) ErrorNotice(message = err!!)

        UiSwitch(
            checked = registrationEnabled,
            onCheckedChange = { next ->
                registrationEnabled = next
                scope.launch {
                    runCatching {
                        controller.central.adminUpdateSiteSettings(buildJsonObject { put("registrationEnabled", next) })
                    }.onFailure { err = it.message }
                }
            },
            label = "Allow Public Account Registration",
            modifier = Modifier.fillMaxWidth(),
        )

        UiField(
            value = searchQuery,
            onValueChange = { q ->
                searchQuery = q
                scope.launch {
                    runCatching { adminTeams = controller.central.adminBillingTeams(q).teams }
                }
            },
            label = "Teams & Manual Plan Grants",
            placeholder = "Search teams…",
        )

        adminTeams.forEach { t ->
            Row(
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(palette.surface).border(1.dp, palette.border, RoundedCornerShape(10.dp)).padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column {
                    Text("${t.name} (${t.billing.plan})", color = palette.text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    Text("Owner: ${t.owner.email}", color = palette.textMuted, fontSize = 12.sp)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("free", "pro", "enterprise").forEach { plan ->
                        UiButton(
                            text = "Grant $plan",
                            size = ButtonSize.SM,
                            active = t.billing.plan == plan,
                            onClick = {
                                scope.launch {
                                    runCatching {
                                        controller.central.adminSetManualGrant(t.id, plan, null, "Site Admin KMP")
                                        adminTeams = controller.central.adminBillingTeams(searchQuery).teams
                                    }.onFailure { err = it.message }
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}
