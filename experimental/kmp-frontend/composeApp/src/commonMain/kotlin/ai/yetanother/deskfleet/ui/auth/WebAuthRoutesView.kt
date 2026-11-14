package ai.yetanother.deskfleet.ui.auth

import ai.yetanother.deskfleet.state.AppController
import ai.yetanother.deskfleet.ui.common.*
import ai.yetanother.deskfleet.ui.theme.LocalDeskFleetColors
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import io.ktor.http.HttpMethod
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/**
 * Dedicated Web `/auth/<route>` router and views matching `packages/components/src/components/auth/AuthPage.vue`:
 * - Strips `#token=...` mailed tokens from browser URL history immediately on mount (`consumeUrlFragmentToken()`).
 * - Supports `/auth/login`, `/auth/register`, `/auth/recovery`, `/auth/verify`, `/auth/recovery/complete`,
 *   `/auth/desktop` (`?attempt=...` PKCE handoff for Desktop & Mobile apps!), `/auth/github-app`,
 *   `/auth/email/verify`, and `/auth/account` (Passkeys, Sessions, Password/Email, Account Deletion).
 */
@Composable
fun WebAuthRoutesView(controller: AppController) {
    val palette = LocalDeskFleetColors.current
    val scope = rememberCoroutineScope()
    val account by controller.central.account.collectAsState()
    val user = account.user

    val route = remember { controller.hostBridge.currentWebPath.trimEnd('/').ifEmpty { "/auth/login" } }
    val attempt = remember { controller.hostBridge.getUrlQueryParam("attempt") }
    val fragmentToken = remember { controller.hostBridge.consumeUrlFragmentToken() }

    var authConfig by remember { mutableStateOf<JsonObject?>(null) }
    var loadingConfig by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }
    var infoMsg by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching {
            authConfig = controller.central.fetchAuthConfig()
            controller.central.refreshStatus()
        }.onFailure { errorMsg = it.message }
        loadingConfig = false
    }

    val requiresSignedIn = route in setOf("/auth/desktop", "/auth/github-app", "/auth/account", "/auth/email/verify")

    Box(
        modifier = Modifier.fillMaxSize().background(palette.canvas).padding(20.dp),
        contentAlignment = Alignment.Center,
    ) {
        val cardShape = RoundedCornerShape(16.dp)
        Column(
            modifier = Modifier
                .widthIn(max = if (route == "/auth/account" && user != null) 620.dp else 440.dp)
                .fillMaxWidth()
                .clip(cardShape)
                .background(palette.surface)
                .border(1.dp, palette.border, cardShape)
                .verticalScroll(rememberScrollState())
                .padding(26.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    BrandLogo(size = 32.dp)
                    Text("DeskFleet", color = palette.text, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                }
                if (user != null) {
                    UiButton(
                        text = "Open Workspace",
                        size = ButtonSize.SM,
                        variant = ButtonVariant.SUBTLE,
                        onClick = { controller.hostBridge.navigateWebPath("/") },
                    )
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

            if (loadingConfig) {
                Text("Loading authentication configuration...", color = palette.textMuted, fontSize = 13.sp)
            } else if (route == "/auth/verify" || route == "/auth/recovery/complete") {
                var displayName by remember { mutableStateOf("") }
                var newPassword by remember { mutableStateOf("") }
                val isVerify = route == "/auth/verify"
                Text(
                    if (isVerify) "Verify Email & Set Password" else "Reset Account Password",
                    color = palette.text,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                if (isVerify) {
                    UiField(value = displayName, onValueChange = { displayName = it }, label = "Display name", placeholder = "Ada Lovelace")
                }
                UiField(value = newPassword, onValueChange = { newPassword = it }, label = "New password", password = true)
                UiButton(
                    text = if (isVerify) "Complete Verification" else "Reset Password",
                    variant = ButtonVariant.PRIMARY,
                    fullWidth = true,
                    loading = busy,
                    enabled = !fragmentToken.isNullOrBlank() && newPassword.length >= 8 && (!isVerify || displayName.isNotBlank()),
                    onClick = {
                        scope.launch {
                            busy = true
                            errorMsg = null
                            runCatching {
                                val body = buildJsonObject {
                                    put("token", fragmentToken.orEmpty())
                                    if (isVerify) put("name", displayName.trim())
                                    put("password", newPassword)
                                }
                                val path = if (isVerify) "/api/auth/verify" else "/api/auth/recovery/complete"
                                controller.central.requestJson(HttpMethod.Post, path, body)
                                controller.central.refreshStatus()
                                controller.hostBridge.navigateWebPath("/")
                            }.onFailure { errorMsg = it.message ?: "Verification failed" }
                            busy = false
                        }
                    },
                )
            } else if (requiresSignedIn && user == null) {
                // Prompt sign-in in place, then resume `/auth/desktop`, `/auth/account`, etc.
                WebSignInCardBody(
                    controller = controller,
                    authConfig = authConfig,
                    returnTo = route + (if (!attempt.isNullOrBlank()) "?attempt=$attempt" else ""),
                    onSignedIn = {
                        scope.launch { controller.central.refreshStatus() }
                    },
                    onError = { errorMsg = it },
                )
            } else when (route) {
                "/auth/desktop" -> {
                    Text("Approve App Sign-In", color = palette.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        "Signed in as ${user?.email.orEmpty()}. Approve this sign-in attempt to connect your DeskFleet Desktop or Mobile client.",
                        color = palette.textMuted,
                        fontSize = 13.sp,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                        UiButton(
                            text = "Approve & Return to App",
                            variant = ButtonVariant.PRIMARY,
                            loading = busy,
                            enabled = !attempt.isNullOrBlank(),
                            onClick = {
                                scope.launch {
                                    busy = true
                                    errorMsg = null
                                    runCatching {
                                        val res = controller.central.requestJson(
                                            HttpMethod.Post,
                                            "/api/auth/desktop/complete",
                                            buildJsonObject { put("attempt", attempt.orEmpty()) },
                                        ).jsonObject
                                        val target = res["returnTo"]?.jsonPrimitive?.contentOrNull
                                        if (!target.isNullOrBlank()) {
                                            controller.hostBridge.openExternalUrl(target)
                                        } else {
                                            infoMsg = "Sign-in approved. You can return to DeskFleet."
                                        }
                                    }.onFailure { errorMsg = it.message ?: "Approval failed" }
                                    busy = false
                                }
                            },
                        )
                        UiButton(
                            text = "Switch Account",
                            variant = ButtonVariant.SUBTLE,
                            onClick = { scope.launch { controller.signOut() } },
                        )
                    }
                }

                "/auth/email/verify" -> {
                    Text("Confirm Email Change", color = palette.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    UiButton(
                        text = "Confirm New Email Address",
                        variant = ButtonVariant.PRIMARY,
                        fullWidth = true,
                        loading = busy,
                        enabled = !fragmentToken.isNullOrBlank(),
                        onClick = {
                            scope.launch {
                                busy = true
                                runCatching {
                                    controller.central.requestJson(
                                        HttpMethod.Post,
                                        "/api/auth/email/verify",
                                        buildJsonObject { put("token", fragmentToken.orEmpty()) },
                                    )
                                    controller.central.refreshStatus()
                                    infoMsg = "Email address updated."
                                }.onFailure { errorMsg = it.message }
                                busy = false
                            }
                        },
                    )
                }

                "/auth/account" -> {
                    WebAccountSecuritySection(
                        controller = controller,
                        onError = { errorMsg = it },
                        onInfo = { infoMsg = it },
                    )
                }

                "/auth/register", "/auth/recovery" -> {
                    val isRegister = route == "/auth/register"
                    var email by remember { mutableStateOf("") }
                    var accepted by remember { mutableStateOf(false) }
                    var shake by remember { mutableIntStateOf(0) }
                    Text(
                        if (isRegister) "Create DeskFleet Account" else "Account Recovery",
                        color = palette.text,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    UiField(value = email, onValueChange = { email = it }, label = "Email", placeholder = "you@example.com")
                    if (isRegister) {
                        UiCheckbox(
                            checked = accepted,
                            onCheckedChange = { accepted = it },
                            label = "I agree to the Terms of Service & Privacy Policy",
                            shakeTrigger = shake,
                        )
                    }
                    UiButton(
                        text = if (isRegister) "Send Verification Link" else "Send Recovery Link",
                        variant = ButtonVariant.PRIMARY,
                        fullWidth = true,
                        loading = busy,
                        enabled = email.isNotBlank(),
                        onClick = {
                            if (isRegister && !accepted) {
                                shake++
                                return@UiButton
                            }
                            scope.launch {
                                busy = true
                                errorMsg = null
                                runCatching {
                                    if (isRegister) {
                                        controller.central.requestJson(
                                            HttpMethod.Post,
                                            "/api/auth/register",
                                            buildJsonObject {
                                                put("email", email.trim())
                                                put("acceptedTerms", true)
                                            },
                                        )
                                        infoMsg = "Check your email for the verification link."
                                    } else {
                                        controller.central.requestJson(
                                            HttpMethod.Post,
                                            "/api/auth/recovery",
                                            buildJsonObject { put("email", email.trim()) },
                                        )
                                        infoMsg = "If that account exists, a recovery link has been sent."
                                    }
                                }.onFailure { errorMsg = it.message }
                                busy = false
                            }
                        },
                    )
                    UiButton(
                        text = "Back to Sign In",
                        variant = ButtonVariant.GHOST,
                        fullWidth = true,
                        onClick = { controller.hostBridge.navigateWebPath("/auth/login") },
                    )
                }

                else -> {
                    WebSignInCardBody(
                        controller = controller,
                        authConfig = authConfig,
                        returnTo = "/",
                        onSignedIn = { controller.hostBridge.navigateWebPath("/") },
                        onError = { errorMsg = it },
                    )
                }
            }
        }
    }
}

@Composable
private fun WebSignInCardBody(
    controller: AppController,
    authConfig: JsonObject?,
    returnTo: String,
    onSignedIn: () -> Unit,
    onError: (String?) -> Unit,
) {
    val palette = LocalDeskFleetColors.current
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    val githubEnabled = authConfig?.get("githubEnabled")?.jsonPrimitive?.booleanOrNull == true
    val googleEnabled = authConfig?.get("googleEnabled")?.jsonPrimitive?.booleanOrNull == true
    val registrationEnabled = authConfig?.get("registrationEnabled")?.jsonPrimitive?.booleanOrNull != false

    Text("Sign in to DeskFleet", color = palette.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    UiField(value = email, onValueChange = { email = it }, label = "Email", placeholder = "you@example.com")
    UiField(value = password, onValueChange = { password = it }, label = "Password", password = true)

    UiButton(
        text = "Sign in",
        variant = ButtonVariant.PRIMARY,
        fullWidth = true,
        loading = busy,
        enabled = email.isNotBlank() && password.isNotEmpty(),
        onClick = {
            scope.launch {
                busy = true
                onError(null)
                runCatching {
                    controller.signInWithPassword(controller.central.currentServerUrl, email, password)
                    onSignedIn()
                }.onFailure { onError(it.message ?: "Sign-in failed") }
                busy = false
            }
        },
    )

    if (controller.hostBridge.supportsBrowserPasskeys) {
        UiButton(
            text = "Sign in with Passkey",
            variant = ButtonVariant.SUBTLE,
            fullWidth = true,
            onClick = {
                scope.launch {
                    onError(null)
                    runCatching {
                        controller.hostBridge.authenticateWithPasskey(
                            controller.central,
                            purpose = "login",
                            email = email.takeIf { it.isNotBlank() },
                        )
                        controller.central.refreshStatus()
                        controller.bootstrapTeamHierarchy()
                        onSignedIn()
                    }.onFailure { onError(it.message ?: "Passkey sign-in failed") }
                }
            },
        )
    }

    if (githubEnabled || googleEnabled) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            if (githubEnabled) {
                Box(Modifier.weight(1f)) {
                    UiButton(
                        text = "Continue with GitHub",
                        fullWidth = true,
                        onClick = {
                            scope.launch {
                                runCatching {
                                    val res = controller.central.requestJson(
                                        HttpMethod.Post,
                                        "/api/auth/github/start",
                                        buildJsonObject { put("returnTo", returnTo); put("acceptedTerms", true) },
                                    ).jsonObject
                                    res["authorizationUrl"]?.jsonPrimitive?.contentOrNull?.let {
                                        controller.hostBridge.openExternalUrl(it)
                                    }
                                }.onFailure { onError(it.message) }
                            }
                        },
                    )
                }
            }
            if (googleEnabled) {
                Box(Modifier.weight(1f)) {
                    UiButton(
                        text = "Continue with Google",
                        fullWidth = true,
                        onClick = {
                            scope.launch {
                                runCatching {
                                    val res = controller.central.requestJson(
                                        HttpMethod.Post,
                                        "/api/auth/google/start",
                                        buildJsonObject { put("returnTo", returnTo); put("acceptedTerms", true) },
                                    ).jsonObject
                                    res["authorizationUrl"]?.jsonPrimitive?.contentOrNull?.let {
                                        controller.hostBridge.openExternalUrl(it)
                                    }
                                }.onFailure { onError(it.message) }
                            }
                        },
                    )
                }
            }
        }
    }

    Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
        if (registrationEnabled) {
            UiButton(
                text = "Create account",
                size = ButtonSize.SM,
                variant = ButtonVariant.GHOST,
                onClick = { controller.hostBridge.navigateWebPath("/auth/register") },
            )
        }
        UiButton(
            text = "Forgot password?",
            size = ButtonSize.SM,
            variant = ButtonVariant.GHOST,
            onClick = { controller.hostBridge.navigateWebPath("/auth/recovery") },
        )
    }
}

@Composable
private fun WebAccountSecuritySection(
    controller: AppController,
    onError: (String?) -> Unit,
    onInfo: (String?) -> Unit,
) {
    val palette = LocalDeskFleetColors.current
    val scope = rememberCoroutineScope()
    var passkeys by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var sessions by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var passkeyName by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }

    suspend fun reloadSecurity() {
        runCatching {
            val pkArr = controller.central.requestJson(HttpMethod.Get, "/api/auth/passkeys") as? JsonArray
            passkeys = pkArr?.mapNotNull { it as? JsonObject }.orEmpty()
            val sessArr = controller.central.requestJson(HttpMethod.Get, "/api/auth/sessions") as? JsonArray
            sessions = sessArr?.mapNotNull { it as? JsonObject }.orEmpty()
        }.onFailure { onError(it.message) }
    }

    LaunchedEffect(Unit) { reloadSecurity() }

    Text("Account Security & Sessions", color = palette.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)

    if (controller.hostBridge.supportsBrowserPasskeys) {
        Text("Passkeys (${passkeys.size})", color = palette.text, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
        passkeys.forEach { pk ->
            val pkId = pk["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
            val name = pk["name"]?.jsonPrimitive?.contentOrNull ?: pkId
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(name, color = palette.textMuted, fontSize = 13.sp)
                UiButton(
                    text = "Remove",
                    size = ButtonSize.SM,
                    variant = ButtonVariant.DANGER,
                    onClick = {
                        scope.launch {
                            runCatching {
                                controller.central.requestJson(HttpMethod.Delete, "/api/auth/passkeys/$pkId")
                                reloadSecurity()
                            }.onFailure { onError(it.message) }
                        }
                    },
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
            Box(Modifier.weight(1f)) {
                UiField(value = passkeyName, onValueChange = { passkeyName = it }, label = "New Passkey Name", placeholder = "MacBook Touch ID")
            }
            UiButton(
                text = "Add Passkey",
                enabled = passkeyName.isNotBlank(),
                onClick = {
                    scope.launch {
                        runCatching {
                            controller.hostBridge.registerBrowserPasskey(controller.central, passkeyName.trim())
                            passkeyName = ""
                            reloadSecurity()
                            onInfo("Passkey registered.")
                        }.onFailure { onError(it.message) }
                    }
                },
            )
        }
    }

    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
        Box(Modifier.weight(1f)) {
            UiField(value = newPassword, onValueChange = { newPassword = it }, label = "Change Password", password = true, placeholder = "At least 8 characters")
        }
        UiButton(
            text = "Update Password",
            enabled = newPassword.length >= 8,
            onClick = {
                scope.launch {
                    runCatching {
                        controller.central.requestJson(
                            HttpMethod.Post,
                            "/api/auth/password",
                            buildJsonObject { put("password", newPassword) },
                        )
                        newPassword = ""
                        onInfo("Password updated.")
                    }.onFailure {
                        if (it.message?.contains("recent_authentication", ignoreCase = true) == true) {
                            controller.setShowReauthDialog(true)
                        } else {
                            onError(it.message)
                        }
                    }
                }
            },
        )
    }

    Text("Active Login Sessions (${sessions.size})", color = palette.text, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
    sessions.forEach { s ->
        val sid = s["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val current = s["current"]?.jsonPrimitive?.booleanOrNull == true
        val created = s["createdAt"]?.jsonPrimitive?.contentOrNull.orEmpty()
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("${if (current) "[Current] " else ""}$created", color = palette.textMuted, fontSize = 12.5.sp)
            if (!current) {
                UiButton(
                    text = "Revoke",
                    size = ButtonSize.SM,
                    variant = ButtonVariant.SUBTLE,
                    onClick = {
                        scope.launch {
                            runCatching {
                                controller.central.requestJson(HttpMethod.Delete, "/api/auth/sessions/$sid")
                                reloadSecurity()
                            }.onFailure { onError(it.message) }
                        }
                    },
                )
            }
        }
    }
}
