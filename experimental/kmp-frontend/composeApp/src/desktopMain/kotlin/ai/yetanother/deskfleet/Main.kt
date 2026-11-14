package ai.yetanother.deskfleet

import ai.yetanother.deskfleet.platform.PlatformKind
import ai.yetanother.deskfleet.state.AppController
import ai.yetanother.deskfleet.ui.DeskFleetApp
import androidx.compose.runtime.*
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.*

private object DeskFleetTrayPainter : Painter() {
    override val intrinsicSize: Size = Size(32f, 32f)
    override fun DrawScope.onDraw() {
        drawCircle(color = Color(0xFF8E9BFF))
    }
}

fun main() = application {
    val controller = remember { AppController() }
    val prefs by controller.preferences.collectAsState()
    var windowVisible by remember { mutableStateOf(true) }

    if (controller.hostBridge.platform.supportsTrayResidency && isTraySupported) {
        Tray(
            icon = DeskFleetTrayPainter,
            tooltip = "DeskFleet",
            onAction = { windowVisible = true },
            menu = {
                Item("Open DeskFleet", onClick = { windowVisible = true })
                Separator()
                Item("Quit DeskFleet", onClick = {
                    controller.dispose()
                    exitApplication()
                })
            },
        )
    }

    if (windowVisible) {
        val state = rememberWindowState(width = 1360.dp, height = 860.dp)
        Window(
            onCloseRequest = {
                if (prefs.closeToTray && isTraySupported) {
                    windowVisible = false
                } else {
                    controller.dispose()
                    exitApplication()
                }
            },
            state = state,
            title = "DeskFleet",
        ) {
            LaunchedEffect(window) {
                if (controller.hostBridge.platform.kind == PlatformKind.DARWIN) {
                    window.rootPane.putClientProperty("apple.awt.fullWindowContent", true)
                    window.rootPane.putClientProperty("apple.awt.transparentTitleBar", true)
                    window.rootPane.putClientProperty("apple.awt.windowTitleVisible", false)
                }
            }
            DeskFleetApp(controller = controller)
        }
    }
}
