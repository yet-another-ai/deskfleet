package ai.yetanother.deskfleet.ui.common

import ai.yetanother.deskfleet.ui.theme.LocalDeskFleetColors
import ai.yetanother.deskfleet.ui.theme.animateSpringFloat
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

enum class ButtonVariant {
    PRIMARY,
    SUBTLE,
    GHOST,
    DANGER,
}

enum class ButtonSize(val height: Dp, val horizontalPadding: Dp, val fontSizeSp: Float) {
    SM(28.dp, 10.dp, 12.5f),
    MD(34.dp, 14.dp, 13.5f),
    ICON(30.dp, 0.dp, 13.5f),
}

/**
 * Exact multiplatform port of `packages/components/src/components/common/UiButton.vue`:
 * - Variants: `PRIMARY`, `SUBTLE`, `GHOST`, `DANGER`
 * - Sizes: `SM`, `MD`, `ICON`
 * - States: `disabled`, `loading` (keeps width stable, shows inline spinner), `placeholder`, `active`.
 */
@Composable
fun UiButton(
    text: String = "",
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: ButtonVariant = ButtonVariant.SUBTLE,
    size: ButtonSize = ButtonSize.MD,
    enabled: Boolean = true,
    loading: Boolean = false,
    placeholder: Boolean = false,
    active: Boolean = false,
    fullWidth: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val palette = LocalDeskFleetColors.current
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val pressed by interaction.collectIsPressedAsState()
    val interactive = enabled && !loading && !placeholder

    val bg = when {
        placeholder -> palette.control.copy(alpha = 0.55f)
        variant == ButtonVariant.PRIMARY -> when {
            !enabled -> palette.action.copy(alpha = 0.45f)
            hovered || pressed -> palette.actionHover
            else -> palette.action
        }
        variant == ButtonVariant.DANGER -> when {
            !enabled -> palette.dangerSoft.copy(alpha = 0.45f)
            hovered || pressed || active -> palette.danger.copy(alpha = 0.24f)
            else -> palette.dangerSoft
        }
        variant == ButtonVariant.SUBTLE -> when {
            active -> palette.accentSoft
            hovered || pressed -> palette.controlHover
            else -> palette.control
        }
        else -> when { // GHOST
            active -> palette.accentSoft
            hovered || pressed -> palette.controlHover.copy(alpha = 0.7f)
            else -> Color.Transparent
        }
    }

    val fg = when (variant) {
        ButtonVariant.PRIMARY -> palette.actionText
        ButtonVariant.DANGER -> palette.danger
        ButtonVariant.SUBTLE, ButtonVariant.GHOST -> if (active) palette.accent else palette.text
    }.let { if (!enabled) it.copy(alpha = 0.5f) else it }

    val borderCol = when (variant) {
        ButtonVariant.PRIMARY -> Color.Transparent
        ButtonVariant.DANGER -> palette.danger.copy(alpha = 0.35f)
        ButtonVariant.SUBTLE -> if (active) palette.accent.copy(alpha = 0.45f) else palette.border
        ButtonVariant.GHOST -> if (active) palette.accent.copy(alpha = 0.35f) else Color.Transparent
    }

    val shape = RoundedCornerShape(8.dp)
    val widthMod = when {
        size == ButtonSize.ICON -> Modifier.size(size.height)
        fullWidth -> Modifier.fillMaxWidth().height(size.height)
        else -> Modifier.height(size.height)
    }

    Box(
        modifier = modifier
            .then(widthMod)
            .clip(shape)
            .background(bg)
            .border(1.dp, borderCol, shape)
            .hoverable(interaction)
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = interactive,
                onClick = onClick,
            )
            .padding(horizontal = size.horizontalPadding),
        contentAlignment = Alignment.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.size(14.dp),
                strokeWidth = 2.dp,
                color = fg,
            )
        } else if (!placeholder) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                leading?.invoke()
                if (text.isNotEmpty()) {
                    Text(
                        text = text,
                        color = fg,
                        fontSize = size.fontSizeSp.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                trailing?.invoke()
            }
        }
    }
}

/**
 * Press-and-hold destructive button (`1200ms` fill + spring-back on early release)
 * matching `packages/components/src/components/common/HoldButton.vue`.
 */
@Composable
fun HoldButton(
    label: String,
    onConfirmed: () -> Unit,
    modifier: Modifier = Modifier,
    holdDurationMs: Long = 1_200L,
    enabled: Boolean = true,
) {
    val palette = LocalDeskFleetColors.current
    val scope = rememberCoroutineScope()
    var targetProgress by remember { mutableFloatStateOf(0f) }
    val animatedProgress by animateSpringFloat(targetValue = targetProgress, duration = 0.22, bounce = 0.05)

    val shape = RoundedCornerShape(8.dp)
    Box(
        modifier = modifier
            .height(32.dp)
            .clip(shape)
            .background(palette.dangerSoft)
            .border(1.dp, palette.danger.copy(alpha = 0.4f), shape)
            .drawWithContent {
                val fillW = size.width * animatedProgress.coerceIn(0f, 1f)
                if (fillW > 0f) {
                    drawRect(
                        color = palette.danger.copy(alpha = 0.35f),
                        size = Size(fillW, size.height),
                    )
                }
                drawContent()
            }
            .pointerInput(enabled, holdDurationMs) {
                if (!enabled) return@pointerInput
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    val timerJob = scope.launch {
                        val steps = 24
                        val stepDelay = holdDurationMs / steps
                        for (i in 1..steps) {
                            delay(stepDelay)
                            targetProgress = i.toFloat() / steps.toFloat()
                        }
                        onConfirmed()
                        targetProgress = 0f
                    }
                    waitForUpOrCancellation()
                    timerJob.cancel()
                    targetProgress = 0f
                }
            }
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = palette.danger,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
        )
    }
}

@Composable
fun UiCheckbox(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    label: String? = null,
    modifier: Modifier = Modifier,
    indeterminate: Boolean = false,
    enabled: Boolean = true,
    shakeTrigger: Int = 0,
) {
    val palette = LocalDeskFleetColors.current
    var shakeOffset by remember { mutableFloatStateOf(0f) }
    val springShake by animateSpringFloat(shakeOffset, duration = 0.25, bounce = 0.45)

    LaunchedEffect(shakeTrigger) {
        if (shakeTrigger > 0) {
            shakeOffset = -6f
            delay(55)
            shakeOffset = 6f
            delay(55)
            shakeOffset = 0f
        }
    }

    Row(
        modifier = modifier
            .offset(x = springShake.dp)
            .clickable(enabled = enabled) { onCheckedChange(!checked) },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val active = checked || indeterminate
        val boxShape = RoundedCornerShape(5.dp)
        Box(
            modifier = Modifier
                .size(18.dp)
                .clip(boxShape)
                .background(if (active) palette.action else palette.control)
                .border(1.dp, if (active) palette.action else palette.borderStrong, boxShape),
            contentAlignment = Alignment.Center,
        ) {
            if (indeterminate) {
                Box(Modifier.size(width = 10.dp, height = 2.dp).background(palette.actionText))
            } else if (checked) {
                Text("✓", color = palette.actionText, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
        }
        if (!label.isNullOrEmpty()) {
            Text(
                text = label,
                color = if (enabled) palette.text else palette.textMuted,
                fontSize = 13.sp,
            )
        }
    }
}

@Composable
fun UiSwitch(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    label: String? = null,
    description: String? = null,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val palette = LocalDeskFleetColors.current
    val thumbFraction by animateSpringFloat(targetValue = if (checked) 1f else 0f, duration = 0.28, bounce = 0.18)

    Row(
        modifier = modifier
            .clickable(enabled = enabled) { onCheckedChange(!checked) },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        if (label != null || description != null) {
            Column(modifier = Modifier.weight(1f).padding(end = 12.dp)) {
                if (label != null) {
                    Text(label, color = palette.text, fontSize = 13.5.sp, fontWeight = FontWeight.Medium)
                }
                if (description != null) {
                    Text(description, color = palette.textMuted, fontSize = 12.sp)
                }
            }
        }
        Box(
            modifier = Modifier
                .width(38.dp)
                .height(22.dp)
                .clip(CircleShape)
                .background(if (checked) palette.action else palette.controlHover)
                .border(1.dp, if (checked) palette.action else palette.borderStrong, CircleShape)
                .padding(2.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            Box(
                modifier = Modifier
                    .offset(x = (16f * thumbFraction).dp)
                    .size(16.dp)
                    .clip(CircleShape)
                    .background(if (checked) palette.actionText else palette.text)
            )
        }
    }
}

@Composable
fun UiField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String = "",
    hint: String? = null,
    error: String? = null,
    password: Boolean = false,
    singleLine: Boolean = true,
    minLines: Int = 1,
    monospace: Boolean = false,
    readOnly: Boolean = false,
    enabled: Boolean = true,
    trailing: (@Composable () -> Unit)? = null,
) {
    val palette = LocalDeskFleetColors.current
    var showPassword by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(8.dp)

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(5.dp)) {
        if (!label.isNullOrEmpty()) {
            Text(label, color = palette.textMuted, fontSize = 12.5.sp, fontWeight = FontWeight.Medium)
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = if (singleLine) 36.dp else (minLines * 22 + 16).dp)
                .clip(shape)
                .background(palette.control)
                .border(1.dp, if (!error.isNullOrEmpty()) palette.danger else palette.border, shape)
                .padding(horizontal = 11.dp, vertical = 8.dp),
            verticalAlignment = if (singleLine) Alignment.CenterVertically else Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(modifier = Modifier.weight(1f)) {
                if (value.isEmpty() && placeholder.isNotEmpty()) {
                    Text(
                        text = placeholder,
                        color = palette.textFaint,
                        fontSize = 13.5.sp,
                        fontFamily = if (monospace) FontFamily.Monospace else FontFamily.Default,
                    )
                }
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    enabled = enabled,
                    readOnly = readOnly,
                    singleLine = singleLine,
                    minLines = minLines,
                    cursorBrush = SolidColor(palette.accent),
                    visualTransformation = if (password && !showPassword) {
                        PasswordVisualTransformation()
                    } else {
                        VisualTransformation.None
                    },
                    textStyle = TextStyle(
                        color = if (enabled) palette.text else palette.textMuted,
                        fontSize = 13.5.sp,
                        fontFamily = if (monospace) FontFamily.Monospace else FontFamily.Default,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (password) {
                Text(
                    text = if (showPassword) "Hide" else "Show",
                    color = palette.textMuted,
                    fontSize = 11.5.sp,
                    modifier = Modifier.clickable { showPassword = !showPassword },
                )
            }
            trailing?.invoke()
        }
        if (!error.isNullOrEmpty()) {
            Text(error, color = palette.danger, fontSize = 12.sp)
        } else if (!hint.isNullOrEmpty()) {
            Text(hint, color = palette.textFaint, fontSize = 12.sp)
        }
    }
}

@Composable
fun UiNumberField(
    value: Int,
    onValueChange: (Int) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    min: Int = 1,
    max: Int = 100_000,
    step: Int = 1,
) {
    val palette = LocalDeskFleetColors.current
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(5.dp)) {
        if (!label.isNullOrEmpty()) {
            Text(label, color = palette.textMuted, fontSize = 12.5.sp, fontWeight = FontWeight.Medium)
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            UiButton(
                text = "−",
                size = ButtonSize.SM,
                enabled = value > min,
                onClick = { onValueChange((value - step).coerceIn(min, max)) },
            )
            BasicTextField(
                value = value.toString(),
                onValueChange = { txt ->
                    txt.toIntOrNull()?.let { n -> onValueChange(n.coerceIn(min, max)) }
                },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                cursorBrush = SolidColor(palette.accent),
                textStyle = TextStyle(color = palette.text, fontSize = 13.5.sp, fontFamily = FontFamily.Monospace),
                modifier = Modifier
                    .width(76.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(palette.control)
                    .border(1.dp, palette.border, RoundedCornerShape(8.dp))
                    .padding(horizontal = 10.dp, vertical = 7.dp),
            )
            UiButton(
                text = "+",
                size = ButtonSize.SM,
                enabled = value < max,
                onClick = { onValueChange((value + step).coerceIn(min, max)) },
            )
        }
    }
}

@Composable
fun UiTimeField(
    valueHhMm: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
) {
    UiField(
        value = valueHhMm,
        onValueChange = { raw ->
            val filtered = raw.filter { it.isDigit() || it == ':' }.take(5)
            onValueChange(filtered)
        },
        label = label,
        placeholder = "09:00",
        monospace = true,
        modifier = modifier,
    )
}

data class SelectOption<T>(
    val value: T,
    val label: String,
    val subtitle: String? = null,
)

@Composable
fun <T> UiSelect(
    options: List<SelectOption<T>>,
    selected: T,
    onSelected: (T) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    searchable: Boolean = false,
) {
    val palette = LocalDeskFleetColors.current
    var expanded by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }
    val selectedOption = options.firstOrNull { it.value == selected }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(5.dp)) {
        if (!label.isNullOrEmpty()) {
            Text(label, color = palette.textMuted, fontSize = 12.5.sp, fontWeight = FontWeight.Medium)
        }
        Box {
            val shape = RoundedCornerShape(8.dp)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(36.dp)
                    .clip(shape)
                    .background(palette.control)
                    .border(1.dp, palette.border, shape)
                    .clickable { expanded = true }
                    .padding(horizontal = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = selectedOption?.label ?: selected?.toString().orEmpty(),
                    color = palette.text,
                    fontSize = 13.5.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text("▾", color = palette.textMuted, fontSize = 12.sp)
            }
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = {
                    expanded = false
                    searchQuery = ""
                },
                modifier = Modifier.background(palette.surfaceElevated),
            ) {
                if (searchable && options.size > 5) {
                    Box(modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
                        UiField(
                            value = searchQuery,
                            onValueChange = { searchQuery = it },
                            placeholder = "Filter...",
                        )
                    }
                }
                val visible = if (searchQuery.isBlank()) {
                    options
                } else {
                    options.filter {
                        it.label.contains(searchQuery, ignoreCase = true) ||
                            it.subtitle?.contains(searchQuery, ignoreCase = true) == true
                    }
                }
                for (opt in visible) {
                    DropdownMenuItem(
                        text = {
                            Column {
                                Text(
                                    opt.label,
                                    color = if (opt.value == selected) palette.accent else palette.text,
                                    fontSize = 13.sp,
                                    fontWeight = if (opt.value == selected) FontWeight.SemiBold else FontWeight.Normal,
                                )
                                if (!opt.subtitle.isNullOrEmpty()) {
                                    Text(opt.subtitle, color = palette.textMuted, fontSize = 11.5.sp)
                                }
                            }
                        },
                        onClick = {
                            onSelected(opt.value)
                            expanded = false
                            searchQuery = ""
                        },
                    )
                }
            }
        }
    }
}
