package ai.yetanother.deskfleet.ui.theme

import androidx.compose.runtime.*
import deskfleet_kmp_frontend.composeapp.generated.resources.Res
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.jetbrains.compose.resources.ExperimentalResourceApi

val SUPPORTED_LOCALES = listOf(
    "system" to "System default",
    "en-US" to "English (US)",
    "zh-cmn-Hans-CN" to "简体中文",
    "ja-JP" to "日本語",
)

@Stable
class I18nCatalog(
    val activeLocale: String,
    private val primaryFlat: Map<String, String>,
    private val fallbackFlat: Map<String, String>,
) {
    fun t(key: String, fallback: String? = null, params: Map<String, Any?> = emptyMap()): String {
        val raw = primaryFlat[key] ?: fallbackFlat[key] ?: fallback ?: key.substringAfterLast('.')
        if (params.isEmpty()) return raw
        var formatted = raw
        for ((k, v) in params) {
            formatted = formatted.replace("{$k}", v?.toString().orEmpty())
        }
        return formatted
    }
}

private fun flattenJsonCatalog(obj: JsonObject, prefix: String = "", out: MutableMap<String, String> = mutableMapOf()): Map<String, String> {
    for ((k, v) in obj) {
        val path = if (prefix.isEmpty()) k else "$prefix.$k"
        when (v) {
            is JsonPrimitive -> out[path] = v.content
            is JsonObject -> flattenJsonCatalog(v, path, out)
            else -> Unit
        }
    }
    return out
}

val LocalI18n = staticCompositionLocalOf {
    I18nCatalog("en-US", emptyMap(), emptyMap())
}

@OptIn(ExperimentalResourceApi::class)
@Composable
fun ProvideDeskFleetI18n(
    preferredLocale: String,
    content: @Composable () -> Unit,
) {
    val resolvedCode = remember(preferredLocale) {
        if (preferredLocale == "system") {
            "en-US"
        } else {
            preferredLocale
        }
    }
    var catalog by remember { mutableStateOf(I18nCatalog(resolvedCode, emptyMap(), emptyMap())) }

    LaunchedEffect(resolvedCode) {
        val json = Json { ignoreUnknownKeys = true }
        val enMap = runCatching {
            val bytes = Res.readBytes("files/locales/en-US.json")
            val el: JsonElement = json.parseToJsonElement(bytes.decodeToString())
            flattenJsonCatalog(el as JsonObject)
        }.getOrDefault(emptyMap())

        val targetMap = if (resolvedCode == "en-US") {
            enMap
        } else {
            runCatching {
                val bytes = Res.readBytes("files/locales/$resolvedCode.json")
                val el: JsonElement = json.parseToJsonElement(bytes.decodeToString())
                flattenJsonCatalog(el as JsonObject)
            }.getOrDefault(enMap)
        }
        catalog = I18nCatalog(resolvedCode, targetMap, enMap)
    }

    CompositionLocalProvider(LocalI18n provides catalog, content = content)
}
