package ai.yetanother.deskfleet.ui.theme

import ai.yetanother.deskfleet.terminal.TerminalCell
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.Color
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlinx.serialization.Serializable

enum class ThemeMode(val wire: String) {
    SYSTEM("system"),
    LIGHT("light"),
    DARK("dark"),
}

@Serializable
data class AppearancePreferences(
    val themeMode: String = "system", // "system" | "light" | "dark"
    val customHueEnabled: Boolean = false,
    val customHueDegrees: Float = 264f,
    val dynamicHue: Boolean = false,
    val locale: String = "system", // "system" | "en-US" | "zh-cmn-Hans-CN" | "ja-JP"
    val terminalPreset: String = "deskfleet-dark",
    val terminalFontSizeSp: Float = 13f,
    val keepAwakeWhileWorking: Boolean = false,
    val notificationsEnabled: Boolean = true,
    val launchAtStartup: Boolean = false,
    val closeToTray: Boolean = true,
)

@Immutable
data class DeskFleetColors(
    val isDark: Boolean,
    val canvas: Color,
    val sidebar: Color,
    val surface: Color,
    val surfaceElevated: Color,
    val control: Color,
    val controlHover: Color,
    val text: Color,
    val textMuted: Color,
    val textFaint: Color,
    val border: Color,
    val borderStrong: Color,
    val accent: Color,
    val accentSoft: Color,
    val action: Color,
    val actionHover: Color,
    val actionText: Color,
    val focus: Color,
    val success: Color,
    val successSoft: Color,
    val warning: Color,
    val warningSoft: Color,
    val danger: Color,
    val dangerSoft: Color,
    val terminalBg: Color,
    val terminalFg: Color,
    val desktopStage: Color,
)

/** Perceptually uniform OKLCH -> sRGB conversion matching `packages/components/src/theme-tokens.css`. */
fun oklchToColor(l: Double, c: Double, hueDegrees: Double, alpha: Float = 1f): Color {
    val hRad = (hueDegrees % 360.0) * (PI / 180.0)
    val a = c * cos(hRad)
    val b = c * sin(hRad)

    val lPrime = l + 0.3963377774 * a + 0.2158037573 * b
    val mPrime = l - 0.1055613458 * a - 0.0638541728 * b
    val sPrime = l - 0.0894841775 * a - 1.2914855480 * b

    val l3 = lPrime * lPrime * lPrime
    val m3 = mPrime * mPrime * mPrime
    val s3 = sPrime * sPrime * sPrime

    val rLin = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
    val gLin = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
    val bLin = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3

    fun gamma(v: Double): Float {
        val clamped = v.coerceIn(0.0, 1.0)
        val encoded = if (clamped <= 0.0031308) {
            12.92 * clamped
        } else {
            1.055 * clamped.pow(1.0 / 2.4) - 0.055
        }
        return encoded.coerceIn(0.0, 1.0).toFloat()
    }

    return Color(gamma(rLin), gamma(gLin), gamma(bLin), alpha)
}

fun buildDeskFleetPalette(isDark: Boolean, customHue: Float?): DeskFleetColors {
    val accent = when {
        customHue != null && isDark -> oklchToColor(0.73, 0.14, customHue.toDouble())
        customHue != null && !isDark -> oklchToColor(0.50, 0.17, customHue.toDouble())
        isDark -> Color(0xFF8E9BFF)
        else -> Color(0xFF4A5BD4)
    }
    val actionHover = when {
        customHue != null && isDark -> oklchToColor(0.78, 0.13, customHue.toDouble())
        customHue != null && !isDark -> oklchToColor(0.45, 0.17, customHue.toDouble())
        isDark -> Color(0xFFA5AFFF)
        else -> Color(0xFF3D4DBF)
    }
    return if (isDark) {
        DeskFleetColors(
            isDark = true,
            canvas = Color(0xFF17191F),
            sidebar = Color(0xFF121419),
            surface = Color(0xFF1F222A),
            surfaceElevated = Color(0xFF262A34),
            control = Color(0xFF23262F),
            controlHover = Color(0xFF2A2E38),
            text = Color(0xFFE7E9EF),
            textMuted = Color(0xFFA3A9B7),
            textFaint = Color(0xFF7C8393),
            border = Color(0xFF2C303A),
            borderStrong = Color(0xFF3A3F4B),
            accent = accent,
            accentSoft = accent.copy(alpha = 0.16f),
            action = accent,
            actionHover = actionHover,
            actionText = Color(0xFF12141A),
            focus = accent,
            success = Color(0xFF4CC38A),
            successSoft = Color(0xFF4CC38A).copy(alpha = 0.16f),
            warning = Color(0xFFE3A64C),
            warningSoft = Color(0xFFE3A64C).copy(alpha = 0.16f),
            danger = Color(0xFFF47C71),
            dangerSoft = Color(0xFFF47C71).copy(alpha = 0.16f),
            terminalBg = Color(0xFF15171D),
            terminalFg = Color(0xFFE7E9EF),
            desktopStage = Color(0xFF15171D),
        )
    } else {
        DeskFleetColors(
            isDark = false,
            canvas = Color(0xFFFBFBFD),
            sidebar = Color(0xFFF3F4F8),
            surface = Color(0xFFFFFFFF),
            surfaceElevated = Color(0xFFFFFFFF),
            control = Color(0xFFFFFFFF),
            controlHover = Color(0xFFF3F4F8),
            text = Color(0xFF1B1F2B),
            textMuted = Color(0xFF596173),
            textFaint = Color(0xFF838A9A),
            border = Color(0xFFE3E6ED),
            borderStrong = Color(0xFFD3D7E0),
            accent = accent,
            accentSoft = accent.copy(alpha = 0.12f),
            action = accent,
            actionHover = actionHover,
            actionText = Color(0xFFFFFFFF),
            focus = accent,
            success = Color(0xFF167A4A),
            successSoft = Color(0xFF167A4A).copy(alpha = 0.12f),
            warning = Color(0xFF975A00),
            warningSoft = Color(0xFF975A00).copy(alpha = 0.12f),
            danger = Color(0xFFC4372F),
            dangerSoft = Color(0xFFC4372F).copy(alpha = 0.12f),
            terminalBg = Color(0xFF15171D),
            terminalFg = Color(0xFFE7E9EF),
            desktopStage = Color(0xFF15171D),
        )
    }
}

data class TerminalColorTheme(
    val id: String,
    val name: String,
    val background: Color,
    val foreground: Color,
    val cursor: Color,
    val selection: Color,
    val ansi16: List<Color>,
) {
    fun resolveCellColor(encoded: Int, isForeground: Boolean): Color {
        if (encoded == TerminalCell.COLOR_DEFAULT_FG) return foreground
        if (encoded == TerminalCell.COLOR_DEFAULT_BG) return background
        if (TerminalCell.isRgb(encoded)) {
            val r = (encoded ushr 16) and 0xFF
            val g = (encoded ushr 8) and 0xFF
            val b = encoded and 0xFF
            return Color(r, g, b)
        }
        val idx = encoded.coerceIn(0, 255)
        if (idx < 16) return ansi16[idx]
        if (idx < 232) {
            val cube = idx - 16
            val steps = intArrayOf(0, 95, 135, 175, 215, 255)
            val r = steps[(cube / 36) % 6]
            val g = steps[(cube / 6) % 6]
            val b = steps[cube % 6]
            return Color(r, g, b)
        }
        val gray = 8 + (idx - 232) * 10
        return Color(gray, gray, gray)
    }
}

val TERMINAL_THEMES: List<TerminalColorTheme> = listOf(
    TerminalColorTheme(
        id = "deskfleet-dark",
        name = "DeskFleet Dark",
        background = Color(0xFF15171D),
        foreground = Color(0xFFE7E9EF),
        cursor = Color(0xFF8E9BFF),
        selection = Color(0x4D8E9BFF),
        ansi16 = listOf(
            Color(0xFF1F222A), Color(0xFFF47C71), Color(0xFF4CC38A), Color(0xFFE3A64C),
            Color(0xFF8E9BFF), Color(0xFFC792EA), Color(0xFF56D4DD), Color(0xFFD5DAE5),
            Color(0xFF596173), Color(0xFFFF958B), Color(0xFF6EE0A8), Color(0xFFF5BF6E),
            Color(0xFFAAB4FF), Color(0xFFDAB1F7), Color(0xFF7BE6EE), Color(0xFFFFFFFF),
        ),
    ),
    TerminalColorTheme(
        id = "deskfleet-light",
        name = "DeskFleet Light",
        background = Color(0xFFFBFBFD),
        foreground = Color(0xFF1B1F2B),
        cursor = Color(0xFF4A5BD4),
        selection = Color(0x334A5BD4),
        ansi16 = listOf(
            Color(0xFF1B1F2B), Color(0xFFC4372F), Color(0xFF167A4A), Color(0xFF975A00),
            Color(0xFF4A5BD4), Color(0xFF7E3AF2), Color(0xFF0E7490), Color(0xFF596173),
            Color(0xFF838A9A), Color(0xFFDC2626), Color(0xFF15803D), Color(0xFFB45309),
            Color(0xFF4F46E5), Color(0xFF9333EA), Color(0xFF0891B2), Color(0xFF0F172A),
        ),
    ),
    TerminalColorTheme(
        id = "catppuccin-mocha",
        name = "Catppuccin Mocha",
        background = Color(0xFF1E1E2E),
        foreground = Color(0xFFCDD6F4),
        cursor = Color(0xFFF5E0DC),
        selection = Color(0x4D89B4FA),
        ansi16 = listOf(
            Color(0xFF45475A), Color(0xFFF38BA8), Color(0xFFA6E3A1), Color(0xFFF9E2AF),
            Color(0xFF89B4FA), Color(0xFFF5C2E7), Color(0xFF94E2D5), Color(0xFFBAC2DE),
            Color(0xFF585B70), Color(0xFFF38BA8), Color(0xFFA6E3A1), Color(0xFFF9E2AF),
            Color(0xFF89B4FA), Color(0xFFF5C2E7), Color(0xFF94E2D5), Color(0xFFA6ADC8),
        ),
    ),
    TerminalColorTheme(
        id = "tokyo-night",
        name = "Tokyo Night",
        background = Color(0xFF1A1B26),
        foreground = Color(0xFFC0CAF5),
        cursor = Color(0xFFC0CAF5),
        selection = Color(0x4D7AA2F7),
        ansi16 = listOf(
            Color(0xFF15161E), Color(0xFFF7768E), Color(0xFF9ECE6A), Color(0xFFE0AF68),
            Color(0xFF7AA2F7), Color(0xFFBB9AF7), Color(0xFF7DCFFF), Color(0xFFA9B1D6),
            Color(0xFF414868), Color(0xFFF7768E), Color(0xFF9ECE6A), Color(0xFFE0AF68),
            Color(0xFF7AA2F7), Color(0xFFBB9AF7), Color(0xFF7DCFFF), Color(0xFFC0CAF5),
        ),
    ),
    TerminalColorTheme(
        id = "solarized-dark",
        name = "Solarized Dark",
        background = Color(0xFF002B36),
        foreground = Color(0xFF839496),
        cursor = Color(0xFF93A1A1),
        selection = Color(0x4D268BD2),
        ansi16 = listOf(
            Color(0xFF073642), Color(0xFFDC322F), Color(0xFF859900), Color(0xFFB58900),
            Color(0xFF268BD2), Color(0xFFD33682), Color(0xFF2AA198), Color(0xFFEEE8D5),
            Color(0xFF002B36), Color(0xFFCB4B16), Color(0xFF586E75), Color(0xFF657B83),
            Color(0xFF839496), Color(0xFF6C71C4), Color(0xFF93A1A1), Color(0xFFFDF6E3),
        ),
    ),
)

val LocalDeskFleetColors = staticCompositionLocalOf {
    buildDeskFleetPalette(isDark = true, customHue = null)
}

@Composable
fun DeskFleetTheme(
    preferences: AppearancePreferences,
    content: @Composable () -> Unit,
) {
    val systemDark = isSystemInDarkTheme()
    val isDark = when (preferences.themeMode) {
        "light" -> false
        "dark" -> true
        else -> systemDark
    }

    var dynamicHueAngle by remember { mutableFloatStateOf(preferences.customHueDegrees) }
    LaunchedEffect(preferences.customHueEnabled, preferences.dynamicHue) {
        if (!preferences.customHueEnabled || !preferences.dynamicHue) return@LaunchedEffect
        var lastNanos = withFrameNanos { it }
        while (true) {
            val now = withFrameNanos { it }
            val dtSec = (now - lastNanos) / 1_000_000_000f
            lastNanos = now
            // Exact DeskFleet dynamic hue speed: 36 degrees per second!
            dynamicHueAngle = (dynamicHueAngle + 36f * dtSec) % 360f
        }
    }

    val activeHue = when {
        !preferences.customHueEnabled -> null
        preferences.dynamicHue -> dynamicHueAngle
        else -> preferences.customHueDegrees
    }

    val palette = remember(isDark, activeHue) { buildDeskFleetPalette(isDark, activeHue) }
    val materialScheme = remember(palette) {
        if (palette.isDark) {
            darkColorScheme(
                primary = palette.action,
                onPrimary = palette.actionText,
                background = palette.canvas,
                onBackground = palette.text,
                surface = palette.surface,
                onSurface = palette.text,
                outline = palette.border,
                error = palette.danger,
            )
        } else {
            lightColorScheme(
                primary = palette.action,
                onPrimary = palette.actionText,
                background = palette.canvas,
                onBackground = palette.text,
                surface = palette.surface,
                onSurface = palette.text,
                outline = palette.border,
                error = palette.danger,
            )
        }
    }

    CompositionLocalProvider(LocalDeskFleetColors provides palette) {
        MaterialTheme(colorScheme = materialScheme, content = content)
    }
}
