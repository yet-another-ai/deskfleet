package io.github.yet_another_ai.deskfleet.nativedesktop

/** The bridge serializes these transitions; every Android launch captures its own request. */
internal class NativeFilePicker<T> {
    class Request<T>(val owner: String, val value: T) {
        var unregister: () -> Unit = {}
        internal var launched = false
    }

    private var pending: Request<T>? = null

    fun begin(owner: String, value: T): Request<T> {
        check(pending == null) { "A folder picker is already open" }
        return Request(owner, value).also { pending = it }
    }

    fun schedule(
        request: Request<T>,
        dispatch: (() -> Unit) -> Unit,
        launch: () -> (() -> Unit),
        failed: (Exception) -> Unit,
    ) {
        try {
            dispatch {
                // Closing an endpoint can settle this request before the UI queue runs.
                // An endpoint ID may already have been reused by a replacement request.
                if (pending !== request || request.launched) return@dispatch
                request.launched = true
                try { request.unregister = launch() }
                catch (error: Exception) { if (finish(request) != null) failed(error) }
            }
        } catch (error: Exception) { if (finish(request) != null) failed(error) }
    }

    fun finish(request: Request<T>): Request<T>? {
        if (pending !== request) return null
        // Clear before releasing the route or resolving JS so reopening cannot stay latched.
        pending = null
        request.unregister()
        return request
    }

    fun cancel(owner: String): Request<T>? = pending?.takeIf { it.owner == owner }?.let(::finish)
}
