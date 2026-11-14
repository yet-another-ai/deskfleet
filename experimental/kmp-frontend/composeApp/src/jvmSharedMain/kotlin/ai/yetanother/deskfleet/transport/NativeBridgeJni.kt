package ai.yetanother.deskfleet.transport

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

internal object NativeBridgeJni {
    val loaded: Boolean by lazy { loadBridgeLibrary() }

    private fun loadBridgeLibrary(): Boolean {
        runCatching {
            System.loadLibrary("deskfleet_kmp_bridge")
            return true
        }
        val os = System.getProperty("os.name").orEmpty().lowercase()
        val libFileName = when {
            os.contains("mac") || os.contains("darwin") -> "libdeskfleet_kmp_bridge.dylib"
            os.contains("win") -> "deskfleet_kmp_bridge.dll"
            else -> "libdeskfleet_kmp_bridge.so"
        }
        val resourceStream = NativeBridgeJni::class.java.getResourceAsStream("/native/$libFileName")
        if (resourceStream != null) {
            return runCatching {
                val suffix = "." + libFileName.substringAfterLast('.')
                val temp = Files.createTempFile("deskfleet_kmp_bridge_", suffix).toFile()
                temp.deleteOnExit()
                resourceStream.use { input ->
                    Files.copy(input, temp.toPath(), StandardCopyOption.REPLACE_EXISTING)
                }
                System.load(temp.absolutePath)
                true
            }.getOrDefault(false)
        }
        val devFallbacks = listOf(
            File("rust-bridge/target/release/$libFileName"),
            File("../rust-bridge/target/release/$libFileName"),
            File("experimental/kmp-frontend/rust-bridge/target/release/$libFileName"),
        )
        for (candidate in devFallbacks) {
            if (candidate.isFile) {
                return runCatching {
                    System.load(candidate.canonicalPath)
                    true
                }.getOrDefault(false)
            }
        }
        return false
    }

    @JvmStatic
    external fun peerCreate(configJson: String): Long

    @JvmStatic
    external fun peerCreateDataChannel(handle: Long, label: String): Boolean

    @JvmStatic
    external fun peerCreateOffer(handle: Long): String

    @JvmStatic
    external fun peerAnswerOffer(handle: Long, sdp: String): String

    @JvmStatic
    external fun peerAcceptAnswer(handle: Long, sdp: String): Boolean

    @JvmStatic
    external fun peerAddIceCandidate(handle: Long, candidateJson: String): Boolean

    @JvmStatic
    external fun peerSendBytes(handle: Long, label: String, payload: ByteArray): Boolean

    @JvmStatic
    external fun peerSendText(handle: Long, label: String, text: String): Boolean

    @JvmStatic
    external fun peerPollEvent(handle: Long, timeoutMs: Long): String?

    @JvmStatic
    external fun peerPollVideoFrame(handle: Long, afterSeq: Long, metaOut: LongArray): ByteArray?

    @JvmStatic
    external fun peerClose(handle: Long)

    @JvmStatic
    external fun testNat(server: String): String

    @JvmStatic
    external fun requestLocalNetwork(): String

    @JvmStatic
    external fun openLocalNetworkSettings(): Boolean
}
