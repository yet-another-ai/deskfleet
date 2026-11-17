package ai.yetanother.deskfleet

import android.os.Bundle
import android.webkit.WebSettings
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        bridge?.webView?.settings?.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
    }
}
