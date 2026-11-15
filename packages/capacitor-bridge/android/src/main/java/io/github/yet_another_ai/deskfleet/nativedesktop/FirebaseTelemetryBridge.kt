package io.github.yet_another_ai.deskfleet.nativedesktop

import android.content.Context
import android.os.Bundle
import com.getcapacitor.JSObject
import com.google.firebase.FirebaseApp
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.analytics.FirebaseAnalytics.ConsentStatus
import com.google.firebase.analytics.FirebaseAnalytics.ConsentType

internal class FirebaseTelemetryBridge(private val context: Context) {
    private fun isConfigured(): Boolean = runCatching {
        if (FirebaseApp.getApps(context).isNotEmpty()) return@runCatching true
        val appIdRes = context.resources.getIdentifier("google_app_id", "string", context.packageName)
        appIdRes != 0 && context.getString(appIdRes).isNotBlank() && FirebaseApp.initializeApp(context) != null
    }.getOrDefault(false)

    fun setConsent(enabled: Boolean): Boolean {
        if (!isConfigured()) return false
        return runCatching {
            val analytics = FirebaseAnalytics.getInstance(context)
            val status = if (enabled) ConsentStatus.GRANTED else ConsentStatus.DENIED
            analytics.setConsent(
                mapOf(
                    ConsentType.ANALYTICS_STORAGE to status,
                    ConsentType.AD_STORAGE to status,
                    ConsentType.AD_USER_DATA to status,
                    ConsentType.AD_PERSONALIZATION to status,
                ),
            )
            analytics.setAnalyticsCollectionEnabled(enabled)
            true
        }.getOrDefault(false)
    }

    fun setUserId(userId: String?): Boolean {
        if (!isConfigured()) return false
        return runCatching {
            val clean = userId?.trim()?.takeIf { it.isNotEmpty() }
            FirebaseAnalytics.getInstance(context).setUserId(clean)
            true
        }.getOrDefault(false)
    }

    fun logEvent(name: String, params: JSObject?): Boolean {
        if (!isConfigured()) return false
        return runCatching {
            val bundle = Bundle()
            if (params != null) {
                val keys = params.keys()
                while (keys.hasNext()) {
                    val rawKey = keys.next()
                    val key = sanitizeIdentifier(rawKey, 40)
                    when (val value = params.opt(rawKey)) {
                        is Boolean -> bundle.putString(key, value.toString())
                        is Int -> bundle.putLong(key, value.toLong())
                        is Long -> bundle.putLong(key, value)
                        is Double -> bundle.putDouble(key, value)
                        is Float -> bundle.putDouble(key, value.toDouble())
                        is Number -> bundle.putDouble(key, value.toDouble())
                        is String -> bundle.putString(key, value.take(100))
                    }
                }
            }
            FirebaseAnalytics.getInstance(context).logEvent(sanitizeIdentifier(name, 40), bundle)
            true
        }.getOrDefault(false)
    }

    companion object {
        internal fun sanitizeIdentifier(raw: String, maxLen: Int = 40): String {
            val cleaned = raw.trim().replace(Regex("[^A-Za-z0-9_]"), "_")
            val prefixed = if (cleaned.isEmpty()) "event"
            else if (cleaned[0].isDigit()) "_$cleaned"
            else cleaned
            return prefixed.take(maxLen)
        }
    }
}
