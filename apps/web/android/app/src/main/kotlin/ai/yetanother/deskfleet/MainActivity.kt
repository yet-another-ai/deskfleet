package ai.yetanother.deskfleet

import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.getcapacitor.BridgeActivity
import com.getcapacitor.BridgeWebViewClient

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        bridge?.let { currentBridge ->
            currentBridge.webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            currentBridge.setWebViewClient(object : BridgeWebViewClient(currentBridge) {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (!request.isForMainFrame) {
                        val url = request.url
                        val host = url.host?.lowercase()
                        if (
                            url.scheme.equals("http", ignoreCase = true) &&
                            (host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]")
                        ) {
                            return false
                        }
                    }
                    return super.shouldOverrideUrlLoading(view, request)
                }
            })
        }
    }
}
