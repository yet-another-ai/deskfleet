package ai.yetanother.deskfleet

import ai.yetanother.deskfleet.platform.IosAuthCallbackBus
import ai.yetanother.deskfleet.state.AppController
import ai.yetanother.deskfleet.ui.DeskFleetApp
import androidx.compose.runtime.remember
import androidx.compose.ui.window.ComposeUIViewController
import platform.UIKit.UIViewController

fun MainViewController(): UIViewController = ComposeUIViewController {
    val controller = remember { AppController() }
    DeskFleetApp(controller = controller)
}

fun handleIosOpenUrl(url: String) {
    IosAuthCallbackBus.onCallbackUrl(url)
}
