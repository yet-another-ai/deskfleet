package ai.yetanother.deskfleet

import ai.yetanother.deskfleet.ui.DeskFleetApp
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.window.ComposeViewport

@OptIn(ExperimentalComposeUiApi::class)
fun main() {
    ComposeViewport(viewportContainerId = "ComposeTarget") {
        DeskFleetApp()
    }
}
