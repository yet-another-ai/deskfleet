package io.github.yet_another_ai.deskfleet.nativedesktop

/** One Rust policy per Activity. ClipboardManager access stays on the host. */
internal interface ClipboardPolicyBridge : AutoCloseable {
    fun update(request: String): String?
}

internal class NativeClipboard : ClipboardPolicyBridge {
    private var handle = nativeCreate()

    @Synchronized
    override fun update(request: String): String? =
        if (handle == 0L) null else nativeUpdate(handle, request)

    @Synchronized
    override fun close() {
        val previous = handle
        handle = 0L
        if (previous != 0L) nativeDestroy(previous)
    }

    companion object {
        init { System.loadLibrary("nsh") }
        @JvmStatic private external fun nativeCreate(): Long
        @JvmStatic private external fun nativeUpdate(handle: Long, request: String): String?
        @JvmStatic private external fun nativeDestroy(handle: Long)
    }
}
