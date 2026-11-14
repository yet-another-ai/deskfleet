package ai.yetanother.deskfleet.android

import ai.yetanother.deskfleet.platform.AndroidAuthCallbackBus
import ai.yetanother.deskfleet.state.AppController
import ai.yetanother.deskfleet.ui.DeskFleetApp
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AndroidAuthCallbackBus.appContext = applicationContext
        AndroidAuthCallbackBus.onDeepLinkUri(intent?.data)
        enableEdgeToEdge()
        setContent {
            val controller = remember { AppController() }
            val sidebarOpen by controller.mobileSidebarOpen.collectAsState()
            val overviewOpen by controller.mobileOverviewOpen.collectAsState()
            BackHandler(enabled = sidebarOpen || overviewOpen) {
                when {
                    sidebarOpen -> controller.setMobileSidebarOpen(false)
                    overviewOpen -> controller.setMobileOverviewOpen(false)
                }
            }
            DeskFleetApp(controller = controller)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        AndroidAuthCallbackBus.onDeepLinkUri(intent.data)
    }
}
