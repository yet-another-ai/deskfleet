package ai.yetanother.deskfleet.ui.common

import ai.yetanother.deskfleet.protocol.FileListing
import ai.yetanother.deskfleet.transport.currentTimeMillis
import ai.yetanother.deskfleet.ui.theme.LocalDeskFleetColors
import ai.yetanother.deskfleet.ui.theme.rememberSpringController
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Modal dialog matching `UiDialog.vue`:
 * - Pressing `Escape` dismisses when `dismissible = true`.
 * - Outside backdrop clicks NEVER dismiss the dialog (`dismissOnClickOutside = false`).
 */
@Composable
fun UiDialog(
    open: Boolean,
    onClose: () -> Unit,
    title: String,
    subtitle: String? = null,
    maxWidth: Dp = 520.dp,
    dismissible: Boolean = true,
    footer: (@Composable RowScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    if (!open) return
    val palette = LocalDeskFleetColors.current
    Dialog(
        onDismissRequest = { if (dismissible) onClose() },
        properties = DialogProperties(
            dismissOnBackPress = dismissible,
            dismissOnClickOutside = false,
            usePlatformDefaultWidth = false,
        ),
    ) {
        val cardShape = RoundedCornerShape(14.dp)
        Column(
            modifier = Modifier
                .widthIn(max = maxWidth)
                .fillMaxWidth(0.94f)
                .clip(cardShape)
                .background(palette.surfaceElevated)
                .border(1.dp, palette.borderStrong, cardShape)
                .onPreviewKeyEvent { ev ->
                    if (dismissible && ev.type == KeyEventType.KeyDown && ev.key == Key.Escape) {
                        onClose()
                        true
                    } else {
                        false
                    }
                }
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(title, color = palette.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    if (!subtitle.isNullOrEmpty()) {
                        Text(subtitle, color = palette.textMuted, fontSize = 12.5.sp)
                    }
                }
                if (dismissible) {
                    UiButton(
                        text = "✕",
                        size = ButtonSize.ICON,
                        variant = ButtonVariant.GHOST,
                        onClick = onClose,
                    )
                }
            }
            Column(
                modifier = Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                content = content,
            )
            if (footer != null) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                    verticalAlignment = Alignment.CenterVertically,
                    content = footer,
                )
            }
        }
    }
}

@Composable
fun ConfirmDialog(
    open: Boolean,
    title: String,
    message: String,
    confirmLabel: String = "Confirm",
    danger: Boolean = false,
    onConfirm: () -> Unit,
    onClose: () -> Unit,
) {
    val palette = LocalDeskFleetColors.current
    UiDialog(
        open = open,
        onClose = onClose,
        title = title,
        maxWidth = 420.dp,
        footer = {
            UiButton(text = "Cancel", variant = ButtonVariant.SUBTLE, onClick = onClose)
            UiButton(
                text = confirmLabel,
                variant = if (danger) ButtonVariant.DANGER else ButtonVariant.PRIMARY,
                onClick = {
                    onConfirm()
                    onClose()
                },
            )
        },
    ) {
        Text(message, color = palette.textMuted, fontSize = 13.5.sp)
    }
}

/**
 * Spring-driven mobile bottom sheet (`<1024dp`) matching `BottomSheet.vue`:
 * - Supports vertical drag-to-dismiss with inertia velocity projection and `48dp` bottom bleed.
 */
@Composable
fun BottomSheet(
    open: Boolean,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    if (!open) return
    val palette = LocalDeskFleetColors.current
    val spring = rememberSpringController(initialValue = 280f, duration = 0.42, bounce = 0.14)
    LaunchedEffect(open) {
        if (open) spring.animateTo(0f)
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.48f))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClose,
            ),
        contentAlignment = Alignment.BottomCenter,
    ) {
        val shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp)
        Column(
            modifier = modifier
                .fillMaxWidth()
                .fillMaxHeight(0.88f)
                .offset { IntOffset(0, spring.value.coerceAtLeast(-24f).roundToInt()) }
                .clip(shape)
                .background(palette.sidebar)
                .border(1.dp, palette.border, shape)
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = {},
                )
                .pointerInput(Unit) {
                    detectVerticalDragGestures(
                        onVerticalDrag = { _, dragAmount ->
                            val next = (spring.value + dragAmount).coerceAtLeast(-20f)
                            spring.dragTo(next, currentTimeMillis())
                        },
                        onDragEnd = {
                            if (spring.value > 140f || spring.velocity > 650f) {
                                onClose()
                            } else {
                                spring.endDrag(0f, currentTimeMillis())
                            }
                        },
                    )
                }
                .padding(bottom = 48.dp),
        ) {
            Box(
                modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier
                        .width(38.dp)
                        .height(4.dp)
                        .clip(CircleShape)
                        .background(palette.borderStrong)
                )
            }
            content()
        }
    }
}

/**
 * Read-only monospace command/token box with `2000ms` `"Copied"` feedback (`CopyField.vue`).
 */
@Composable
fun CopyField(
    value: String,
    onCopy: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
) {
    val palette = LocalDeskFleetColors.current
    var copied by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(5.dp)) {
        if (!label.isNullOrEmpty()) {
            Text(label, color = palette.textMuted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
        }
        val shape = RoundedCornerShape(8.dp)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(palette.control)
                .border(1.dp, palette.border, shape)
                .padding(horizontal = 10.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = value,
                color = palette.text,
                fontSize = 12.5.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            UiButton(
                text = if (copied) "✓ Copied" else "Copy",
                size = ButtonSize.SM,
                variant = if (copied) ButtonVariant.PRIMARY else ButtonVariant.SUBTLE,
                onClick = {
                    onCopy(value)
                    copied = true
                    scope.launch {
                        delay(2_000L)
                        copied = false
                    }
                },
            )
        }
    }
}

/**
 * Error banner with expandable detail trace and platform-parity mobile billing CTA suppression (`ErrorNotice.vue`).
 */
@Composable
fun ErrorNotice(
    message: String,
    modifier: Modifier = Modifier,
    details: String? = null,
    isBillingLimit: Boolean = false,
    suppressBillingPricing: Boolean = false,
    onOpenBilling: (() -> Unit)? = null,
    onDismiss: (() -> Unit)? = null,
) {
    val palette = LocalDeskFleetColors.current
    var expanded by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(10.dp)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(palette.dangerSoft)
            .border(1.dp, palette.danger.copy(alpha = 0.38f), shape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("⚠", color = palette.danger, fontSize = 14.sp)
            Text(
                text = message,
                color = palette.text,
                fontSize = 13.sp,
                modifier = Modifier.weight(1f),
            )
            if (isBillingLimit && !suppressBillingPricing && onOpenBilling != null) {
                UiButton(text = "Upgrade plan", size = ButtonSize.SM, variant = ButtonVariant.PRIMARY, onClick = onOpenBilling)
            }
            if (!details.isNullOrBlank()) {
                UiButton(
                    text = if (expanded) "Hide details" else "Details",
                    size = ButtonSize.SM,
                    variant = ButtonVariant.GHOST,
                    onClick = { expanded = !expanded },
                )
            }
            if (onDismiss != null) {
                UiButton(text = "✕", size = ButtonSize.ICON, variant = ButtonVariant.GHOST, onClick = onDismiss)
            }
        }
        AnimatedVisibility(visible = expanded && !details.isNullOrBlank()) {
            Text(
                text = details.orEmpty(),
                color = palette.textMuted,
                fontSize = 11.5.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

@Composable
fun SpringCollapse(
    visible: Boolean,
    content: @Composable () -> Unit,
) {
    AnimatedVisibility(
        visible = visible,
        enter = expandVertically() + fadeIn(),
        exit = shrinkVertically() + fadeOut(),
    ) {
        content()
    }
}

@Composable
fun BrandLogo(size: Dp = 28.dp) {
    val palette = LocalDeskFleetColors.current
    val shape = RoundedCornerShape((size.value * 0.28f).dp)
    Box(
        modifier = Modifier
            .size(size)
            .clip(shape)
            .background(
                Brush.linearGradient(
                    listOf(palette.action, palette.accent.copy(alpha = 0.72f))
                )
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "DF",
            color = palette.actionText,
            fontSize = (size.value * 0.42f).sp,
            fontWeight = FontWeight.ExtraBold,
        )
    }
}

@Composable
fun StatusDot(online: Boolean, working: Boolean = false, attention: Boolean = false) {
    val palette = LocalDeskFleetColors.current
    val color = when {
        attention -> palette.warning
        working -> palette.accent
        online -> palette.success
        else -> palette.textFaint.copy(alpha = 0.55f)
    }
    Box(
        modifier = Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(color)
    )
}

@Composable
fun ProviderBadge(providerId: String) {
    val palette = LocalDeskFleetColors.current
    val short = when {
        providerId.contains("claude", ignoreCase = true) -> "CC"
        providerId.contains("codex", ignoreCase = true) -> "CX"
        providerId.contains("gemini", ignoreCase = true) -> "GM"
        providerId.contains("cursor", ignoreCase = true) -> "CR"
        else -> providerId.take(2).uppercase()
    }
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(5.dp))
            .background(palette.accentSoft)
            .padding(horizontal = 5.dp, vertical = 2.dp),
    ) {
        Text(short, color = palette.accent, fontSize = 10.5.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun UserAvatar(name: String, email: String = "", size: Dp = 26.dp) {
    val palette = LocalDeskFleetColors.current
    val initial = (name.trim().firstOrNull() ?: email.trim().firstOrNull() ?: '?').uppercaseChar().toString()
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(palette.accentSoft)
            .border(1.dp, palette.accent.copy(alpha = 0.4f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(initial, color = palette.accent, fontSize = (size.value * 0.46f).sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun FolderPickerDialog(
    open: Boolean,
    title: String = "Select directory",
    loadDirectory: suspend (String?) -> FileListing,
    onPicked: (String) -> Unit,
    onClose: () -> Unit,
) {
    val palette = LocalDeskFleetColors.current
    var listing by remember { mutableStateOf<FileListing?>(null) }
    var manualPath by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(open) {
        if (open) {
            runCatching { loadDirectory(null) }
                .onSuccess {
                    listing = it
                    manualPath = it.path
                }
                .onFailure { error = it.message }
        }
    }

    UiDialog(
        open = open,
        onClose = onClose,
        title = title,
        footer = {
            UiButton(text = "Cancel", variant = ButtonVariant.SUBTLE, onClick = onClose)
            UiButton(
                text = "Select folder",
                variant = ButtonVariant.PRIMARY,
                enabled = manualPath.isNotBlank(),
                onClick = {
                    onPicked(manualPath.trim())
                    onClose()
                },
            )
        },
    ) {
        UiField(
            value = manualPath,
            onValueChange = { manualPath = it },
            label = "Directory path",
            monospace = true,
            trailing = {
                UiButton(
                    text = "Go",
                    size = ButtonSize.SM,
                    onClick = {
                        scope.launch {
                            runCatching { loadDirectory(manualPath.trim()) }
                                .onSuccess {
                                    listing = it
                                    manualPath = it.path
                                    error = null
                                }
                                .onFailure { error = it.message }
                        }
                    },
                )
            },
        )
        if (!error.isNullOrEmpty()) {
            ErrorNotice(message = error!!)
        }
        val cur = listing
        if (cur != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (cur.parent != null) {
                    UiButton(
                        text = "↑ Parent",
                        size = ButtonSize.SM,
                        onClick = {
                            scope.launch {
                                runCatching { loadDirectory(cur.parent) }.onSuccess {
                                    listing = it
                                    manualPath = it.path
                                }
                            }
                        },
                    )
                }
                for (root in cur.roots.take(4)) {
                    UiButton(
                        text = root,
                        size = ButtonSize.SM,
                        onClick = {
                            scope.launch {
                                runCatching { loadDirectory(root) }.onSuccess {
                                    listing = it
                                    manualPath = it.path
                                }
                            }
                        },
                    )
                }
            }
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 240.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .border(1.dp, palette.border, RoundedCornerShape(8.dp))
                    .verticalScroll(rememberScrollState()),
            ) {
                for (entry in cur.entries.filter { it.kind == "directory" }) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                scope.launch {
                                    runCatching { loadDirectory(entry.path) }.onSuccess {
                                        listing = it
                                        manualPath = it.path
                                    }
                                }
                            }
                            .padding(horizontal = 10.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("📁", fontSize = 13.sp)
                        Text(entry.name, color = palette.text, fontSize = 13.sp, maxLines = 1)
                    }
                }
            }
        }
    }
}
