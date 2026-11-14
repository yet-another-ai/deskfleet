package ai.yetanother.deskfleet.ui.auth

import ai.yetanother.deskfleet.state.AppController
import ai.yetanother.deskfleet.ui.common.*
import ai.yetanother.deskfleet.ui.theme.LocalDeskFleetColors
import ai.yetanother.deskfleet.ui.theme.LocalI18n
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/**
 * Full-screen authentication page (`SignInForm.vue` + `EmailLinkForm.vue`):
 * - Supports both direct email+password login (`POST /api/auth/login` + PKCE Bearer upgrade)
 *   AND browser/deep-link PKCE (`POST /api/auth/start` + `/api/auth/exchange`).
 * - Supports account registration with terms-checkbox spring shake validation and password recovery.
 */
@Composable
fun AuthPage(controller: AppController) {
    val palette = LocalDeskFleetColors.current
    val i18n = LocalI18n.current
    val account by controller.central.account.collectAsState()
    val scope = rememberCoroutineScope()

    var serverUrl by remember(account.serverUrl) { mutableStateOf(account.serverUrl) }
    var authTab by remember { mutableStateOf("signin") } // "signin" | "register" | "recover"
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var agreedTerms by remember { mutableStateOf(false) }
    var termsShake by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var browserBusy by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }
    var infoMsg by remember { mutableStateOf<String?>(null) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.canvas)
            .padding(20.dp),
        contentAlignment = Alignment.Center,
    ) {
        val cardShape = RoundedCornerShape(16.dp)
        Column(
            modifier = Modifier
                .widthIn(max = 430.dp)
                .fillMaxWidth()
                .clip(cardShape)
                .background(palette.surface)
                .border(1.dp, palette.border, cardShape)
                .verticalScroll(rememberScrollState())
                .padding(26.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                BrandLogo(size = 36.dp)
                Column {
                    Text("DeskFleet", color = palette.text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Text(
                        text = i18n.t("auth.subtitle", "Manage AI agents & machines across your team"),
                        color = palette.textMuted,
                        fontSize = 12.5.sp,
                    )
                }
            }

            if (!controller.hostBridge.platform.locksServerUrlToOrigin) {
                UiField(
                    value = serverUrl,
                    onValueChange = { serverUrl = it },
                    label = "Central Server URL",
                    placeholder = "http://localhost:8080",
                    monospace = true,
                )
            }

            // Mode Segmented Control
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(9.dp))
                    .background(palette.control)
                    .border(1.dp, palette.border, RoundedCornerShape(9.dp))
                    .padding(3.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                listOf(
                    "signin" to "Sign in",
                    "register" to "Register",
                    "recover" to "Recover",
                ).forEach { (key, label) ->
                    val active = authTab == key
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .height(30.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(if (active) palette.surfaceElevated else androidx.compose.ui.graphics.Color.Transparent)
                            .clickable {
                                authTab = key
                                errorMsg = null
                                infoMsg = null
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            label,
                            color = if (active) palette.text else palette.textMuted,
                            fontSize = 12.5.sp,
                            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                        )
                    }
                }
            }

            if (!errorMsg.isNullOrEmpty()) {
                ErrorNotice(message = errorMsg!!, onDismiss = { errorMsg = null })
            }
            if (!infoMsg.isNullOrEmpty()) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(palette.successSoft)
                        .border(1.dp, palette.success.copy(alpha = 0.4f), RoundedCornerShape(8.dp))
                        .padding(10.dp),
                ) {
                    Text(infoMsg!!, color = palette.success, fontSize = 12.5.sp)
                }
            }

            when (authTab) {
                "signin" -> {
                    UiField(
                        value = email,
                        onValueChange = { email = it },
                        label = "Email",
                        placeholder = "you@example.com",
                    )
                    UiField(
                        value = password,
                        onValueChange = { password = it },
                        label = "Password",
                        placeholder = "••••••••",
                        password = true,
                    )
                    UiButton(
                        text = "Sign in",
                        variant = ButtonVariant.PRIMARY,
                        fullWidth = true,
                        loading = busy,
                        enabled = email.isNotBlank() && password.isNotEmpty(),
                        onClick = {
                            scope.launch {
                                busy = true
                                errorMsg = null
                                runCatching {
                                    controller.signInWithPassword(serverUrl, email, password)
                                }.onFailure { err ->
                                    errorMsg = err.message ?: "Sign-in failed"
                                }
                                busy = false
                            }
                        },
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Box(Modifier.weight(1f).height(1.dp).background(palette.border))
                        Text("or", color = palette.textFaint, fontSize = 11.5.sp)
                        Box(Modifier.weight(1f).height(1.dp).background(palette.border))
                    }
                    UiButton(
                        text = when {
                            controller.hostBridge.platform.isWeb -> "Sign in with Passkey"
                            controller.hostBridge.platform.isMobile -> "Continue with Browser / Passkey"
                            else -> "Sign in via Browser (PKCE / Passkey / SSO)"
                        },
                        variant = ButtonVariant.SUBTLE,
                        fullWidth = true,
                        loading = browserBusy,
                        onClick = {
                            scope.launch {
                                browserBusy = true
                                errorMsg = null
                                runCatching {
                                    if (controller.hostBridge.platform.isWeb) {
                                        controller.hostBridge.authenticateWithPasskey(
                                            controller.central,
                                            purpose = "login",
                                            email = email.takeIf { it.isNotBlank() },
                                        )
                                        controller.central.refreshStatus()
                                        controller.bootstrapTeamHierarchy()
                                    } else {
                                        controller.signInWithBrowser(serverUrl)
                                    }
                                }.onFailure { err ->
                                    errorMsg = err.message ?: "Authentication failed"
                                }
                                browserBusy = false
                            }
                        },
                    )
                }

                "register" -> {
                    UiField(
                        value = name,
                        onValueChange = { name = it },
                        label = "Display name",
                        placeholder = "Ada Lovelace",
                    )
                    UiField(
                        value = email,
                        onValueChange = { email = it },
                        label = "Email",
                        placeholder = "you@example.com",
                    )
                    UiField(
                        value = password,
                        onValueChange = { password = it },
                        label = "Password",
                        placeholder = "At least 8 characters",
                        password = true,
                    )
                    UiCheckbox(
                        checked = agreedTerms,
                        onCheckedChange = { agreedTerms = it },
                        label = "I agree to the Terms of Service and Privacy Policy",
                        shakeTrigger = termsShake,
                    )
                    UiButton(
                        text = "Create account",
                        variant = ButtonVariant.PRIMARY,
                        fullWidth = true,
                        loading = busy,
                        enabled = email.isNotBlank() && password.length >= 8,
                        onClick = {
                            if (!agreedTerms) {
                                termsShake++
                                return@UiButton
                            }
                            scope.launch {
                                busy = true
                                errorMsg = null
                                infoMsg = null
                                runCatching {
                                    controller.registerAccount(serverUrl, name, email, password)
                                    // Immediately sign in if local/dev server permits unverified or auto-verified login:
                                    runCatching { controller.signInWithPassword(serverUrl, email, password) }
                                        .onFailure {
                                            infoMsg = "Account created! Check your email or sign in."
                                            authTab = "signin"
                                        }
                                }.onFailure { err ->
                                    errorMsg = err.message ?: "Registration failed"
                                }
                                busy = false
                            }
                        },
                    )
                }

                "recover" -> {
                    UiField(
                        value = email,
                        onValueChange = { email = it },
                        label = "Account email",
                        placeholder = "you@example.com",
                    )
                    UiButton(
                        text = "Send recovery email",
                        variant = ButtonVariant.PRIMARY,
                        fullWidth = true,
                        loading = busy,
                        enabled = email.isNotBlank(),
                        onClick = {
                            scope.launch {
                                busy = true
                                errorMsg = null
                                runCatching {
                                    controller.central.setServerUrl(serverUrl)
                                    controller.central.requestPasswordRecovery(email)
                                    infoMsg = "If an account exists for $email, a reset link has been sent."
                                }.onFailure { err ->
                                    errorMsg = err.message ?: "Recovery request failed"
                                }
                                busy = false
                            }
                        },
                    )
                }
            }
        }
    }
}

/**
 * Platform-aware first-run permission & setup onboarding (`WelcomePage.vue`).
 */
@Composable
fun WelcomePage(controller: AppController) {
    val palette = LocalDeskFleetColors.current
    val steps = remember { controller.hostBridge.platform.onboardingSteps(localAgent = true) }
    var currentStepIdx by remember { mutableIntStateOf(0) }

    if (steps.isEmpty()) {
        LaunchedEffect(Unit) { controller.completeOnboarding() }
        return
    }

    val activeStep = steps.getOrElse(currentStepIdx) { steps.last() }
    val (stepTitle, stepDesc) = when (activeStep) {
        "localNetwork" -> "Local Network Access" to
            "Allow DeskFleet to discover direct LAN WebRTC paths to other machines on your Wi-Fi or Ethernet network."
        "fullDiskAccess" -> "Full Disk Access" to
            "Grant Full Disk Access so local AI agents and terminals can work inside protected project folders."
        "screenCapture" -> "Screen Recording" to
            "Enable Screen Recording if you want to stream this computer's display to remote DeskFleet sessions."
        "accessibility" -> "Accessibility Control" to
            "Enable Accessibility so remote desktop sessions can inject keyboard and pointer events when authorized."
        "windowsDesktopService" -> "Windows Desktop Service" to
            "Optional system service for UAC secure-desktop streaming and Ctrl+Alt+Del injection."
        else -> activeStep to ""
    }

    Box(
        modifier = Modifier.fillMaxSize().background(palette.canvas).padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        val shape = RoundedCornerShape(16.dp)
        Row(
            modifier = Modifier
                .widthIn(max = 760.dp)
                .fillMaxWidth()
                .clip(shape)
                .background(palette.surface)
                .border(1.dp, palette.border, shape)
                .padding(24.dp),
            horizontalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            Column(
                modifier = Modifier.width(210.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                BrandLogo(32.dp)
                Spacer(Modifier.height(4.dp))
                Text("Host Setup", color = palette.text, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                steps.forEachIndexed { idx, stepKey ->
                    val active = idx == currentStepIdx
                    val done = idx < currentStepIdx
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(7.dp))
                            .background(if (active) palette.accentSoft else androidx.compose.ui.graphics.Color.Transparent)
                            .clickable { currentStepIdx = idx }
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                    ) {
                        Text(
                            if (done) "✓" else "${idx + 1}.",
                            color = if (active || done) palette.accent else palette.textMuted,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            stepKey,
                            color = if (active) palette.text else palette.textMuted,
                            fontSize = 12.5.sp,
                        )
                    }
                }
            }

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text(stepTitle, color = palette.text, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                Text(stepDesc, color = palette.textMuted, fontSize = 13.5.sp)
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    UiButton(
                        text = "Skip setup",
                        variant = ButtonVariant.GHOST,
                        onClick = { controller.completeOnboarding() },
                    )
                    UiButton(
                        text = if (currentStepIdx < steps.lastIndex) "Next step" else "Finish setup",
                        variant = ButtonVariant.PRIMARY,
                        onClick = {
                            if (currentStepIdx < steps.lastIndex) {
                                currentStepIdx++
                            } else {
                                controller.completeOnboarding()
                            }
                        },
                    )
                }
            }
        }
    }
}

/**
 * Shown when signed-in user belongs to zero Teams (`TeamOnboarding.vue`).
 */
@Composable
fun TeamOnboardingView(controller: AppController) {
    val palette = LocalDeskFleetColors.current
    val scope = rememberCoroutineScope()
    var teamName by remember { mutableStateOf("") }
    var inviteToken by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Box(
        modifier = Modifier.fillMaxSize().background(palette.canvas).padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        val shape = RoundedCornerShape(16.dp)
        Column(
            modifier = Modifier
                .widthIn(max = 460.dp)
                .fillMaxWidth()
                .clip(shape)
                .background(palette.surface)
                .border(1.dp, palette.border, shape)
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("Create or join a Team", color = palette.text, fontSize = 19.sp, fontWeight = FontWeight.Bold)
            Text(
                "Teams own Machine registrations, Agent Sessions, Terminals, and Access Policies.",
                color = palette.textMuted,
                fontSize = 13.sp,
            )
            if (!error.isNullOrEmpty()) ErrorNotice(message = error!!)

            UiField(
                value = teamName,
                onValueChange = { teamName = it },
                label = "New Team Name",
                placeholder = "Engineering",
            )
            UiButton(
                text = "Create Team",
                variant = ButtonVariant.PRIMARY,
                fullWidth = true,
                loading = busy,
                enabled = teamName.isNotBlank(),
                onClick = {
                    scope.launch {
                        busy = true
                        error = null
                        runCatching { controller.createTeam(teamName) }
                            .onFailure { error = it.message }
                        busy = false
                    }
                },
            )

            Box(Modifier.fillMaxWidth().height(1.dp).background(palette.border))

            UiField(
                value = inviteToken,
                onValueChange = { inviteToken = it },
                label = "Have an invite token?",
                placeholder = "Paste invite token",
                monospace = true,
            )
            UiButton(
                text = "Join Team with Invite",
                variant = ButtonVariant.SUBTLE,
                fullWidth = true,
                enabled = inviteToken.isNotBlank() && !busy,
                onClick = {
                    scope.launch {
                        busy = true
                        error = null
                        runCatching {
                            val joined = controller.central.acceptInvite(inviteToken)
                            controller.bootstrapTeamHierarchy()
                            controller.selectTeam(joined.id)
                        }.onFailure { error = it.message }
                        busy = false
                    }
                },
            )
        }
    }
}

/**
 * Add Machine Dialog (`AddMachineDialog.vue`):
 * - Desktop (`supportsLocalDaemon`): Mode `"This computer"` vs `"Headless server"`.
 * - Mobile (`isMobile`): Skips directly to `"Headless server"` CLI enrollment wizard!
 */
@Composable
fun AddMachineDialog(
    open: Boolean,
    controller: AppController,
    onClose: () -> Unit,
) {
    val palette = LocalDeskFleetColors.current
    val supportsLocal = controller.hostBridge.platform.supportsLocalDaemon
    val daemonStatus by controller.localDaemonStatus.collectAsState()
    val selectedTeamId by controller.selectedTeamId.collectAsState()
    val scope = rememberCoroutineScope()

    var mode by remember(supportsLocal) { mutableStateOf(if (supportsLocal) "local" else "headless") }
    var machineName by remember(daemonStatus.machineName) {
        mutableStateOf(daemonStatus.machineName.ifBlank { controller.hostBridge.platform.hostname })
    }
    var headlessOs by remember { mutableStateOf("linux") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    UiDialog(
        open = open,
        onClose = onClose,
        title = "Add Machine",
        subtitle = "Connect a local workstation or remote headless server to this Team",
        footer = {
            UiButton(text = "Close", variant = ButtonVariant.SUBTLE, onClick = onClose)
            if (mode == "local") {
                UiButton(
                    text = "Enroll this computer",
                    variant = ButtonVariant.PRIMARY,
                    loading = busy,
                    enabled = daemonStatus.available && selectedTeamId != null,
                    onClick = {
                        scope.launch {
                            busy = true
                            error = null
                            runCatching {
                                controller.enrollThisComputer(machineName)
                                onClose()
                            }.onFailure { error = it.message }
                            busy = false
                        }
                    },
                )
            }
        },
    ) {
        if (supportsLocal) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                UiButton(
                    text = "This computer",
                    variant = ButtonVariant.SUBTLE,
                    active = mode == "local",
                    onClick = { mode = "local" },
                    modifier = Modifier.weight(1f),
                )
                UiButton(
                    text = "Headless server",
                    variant = ButtonVariant.SUBTLE,
                    active = mode == "headless",
                    onClick = { mode = "headless" },
                    modifier = Modifier.weight(1f),
                )
            }
        }

        if (!error.isNullOrEmpty()) ErrorNotice(message = error!!)

        if (mode == "local") {
            Text(
                text = if (daemonStatus.available) {
                    "Local DeskFleet daemon detected (${daemonStatus.daemonDirectory})."
                } else {
                    "Local daemon not detected in default path. Start `deskfleet-daemon` first or use Headless setup."
                },
                color = if (daemonStatus.available) palette.success else palette.warning,
                fontSize = 12.5.sp,
            )
            UiField(
                value = machineName,
                onValueChange = { machineName = it },
                label = "Machine Display Name",
            )
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("linux" to "Linux", "darwin" to "macOS", "win32" to "Windows").forEach { (osKey, lbl) ->
                    UiButton(
                        text = lbl,
                        size = ButtonSize.SM,
                        active = headlessOs == osKey,
                        onClick = { headlessOs = osKey },
                    )
                }
            }
            val installCmd = if (headlessOs == "win32") {
                "irm https://deskfleet.ai/install.ps1 | iex"
            } else {
                "curl -fsSL https://deskfleet.ai/install.sh | sh"
            }
            val enrollCmd = "deskfleet-daemon enroll --server ${controller.central.currentServerUrl} --team ${selectedTeamId.orEmpty()}"
            CopyField(
                label = "1. Install DeskFleet daemon on the target machine",
                value = installCmd,
                onCopy = { controller.hostBridge.copyToClipboard(it) },
            )
            CopyField(
                label = "2. Enroll into this Team",
                value = enrollCmd,
                onCopy = { controller.hostBridge.copyToClipboard(it) },
            )
        }
    }
}

@Composable
fun CreateTeamDialog(
    open: Boolean,
    controller: AppController,
    onClose: () -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    UiDialog(
        open = open,
        onClose = onClose,
        title = "Create Team",
        maxWidth = 400.dp,
        footer = {
            UiButton(text = "Cancel", variant = ButtonVariant.SUBTLE, onClick = onClose)
            UiButton(
                text = "Create",
                variant = ButtonVariant.PRIMARY,
                loading = busy,
                enabled = name.isNotBlank(),
                onClick = {
                    scope.launch {
                        busy = true
                        runCatching {
                            controller.createTeam(name)
                            name = ""
                            onClose()
                        }.onFailure { error = it.message }
                        busy = false
                    }
                },
            )
        },
    ) {
        if (!error.isNullOrEmpty()) ErrorNotice(message = error!!)
        UiField(value = name, onValueChange = { name = it }, label = "Team Name", placeholder = "Platform Team")
    }
}

@Composable
fun ReauthDialog(
    open: Boolean,
    controller: AppController,
    onClose: () -> Unit,
) {
    var password by remember { mutableStateOf("") }
    var emailCode by remember { mutableStateOf("") }
    var challengeId by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    UiDialog(
        open = open,
        onClose = onClose,
        title = "Confirm your identity",
        subtitle = "Step-up verification is required before changing sensitive security settings.",
        maxWidth = 420.dp,
        footer = {
            UiButton(text = "Cancel", variant = ButtonVariant.SUBTLE, onClick = onClose)
            UiButton(
                text = "Verify",
                variant = ButtonVariant.PRIMARY,
                loading = busy,
                enabled = password.isNotEmpty() || (!challengeId.isNullOrEmpty() && emailCode.length >= 6),
                onClick = {
                    scope.launch {
                        busy = true
                        error = null
                        runCatching {
                            if (challengeId != null && emailCode.isNotBlank()) {
                                controller.central.verifyReauthEmailCode(challengeId!!, emailCode)
                            } else {
                                controller.central.reauthenticateWithPassword(password)
                            }
                            onClose()
                        }.onFailure { error = it.message }
                        busy = false
                    }
                },
            )
        },
    ) {
        if (!error.isNullOrEmpty()) ErrorNotice(message = error!!)
        UiField(value = password, onValueChange = { password = it }, label = "Password", password = true)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            UiButton(
                text = "Send email code instead",
                size = ButtonSize.SM,
                onClick = {
                    scope.launch {
                        runCatching {
                            val obj = controller.central.sendReauthEmailCode()
                            challengeId = obj["challengeId"]?.toString()?.trim('"')
                        }.onFailure { error = it.message }
                    }
                },
            )
        }
        if (challengeId != null) {
            UiField(
                value = emailCode,
                onValueChange = { emailCode = it },
                label = "6-digit Email Verification Code",
                monospace = true,
            )
        }
    }
}
