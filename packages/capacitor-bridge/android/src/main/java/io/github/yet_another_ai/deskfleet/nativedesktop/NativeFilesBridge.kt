package io.github.yet_another_ai.deskfleet.nativedesktop

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/** Keeps account lifetimes and directory-picker UI separate from the file protocol. */
internal class NativeFilesBridge(private val context: Context) {
    private class Session(val endpoint: NativeFilesEndpoint) {
        val worker = Executors.newSingleThreadExecutor()
    }
    private val sessions = mutableMapOf<String, Session>()
    private val picker = NativeFilePicker<PluginCall>()
    private var disposed = false

    private fun id(call: PluginCall): String = call.getString("id")?.takeIf { it.isNotEmpty() }
        ?: throw NativeFileException("Missing file endpoint ID")

    private fun reject(call: PluginCall, error: Exception) {
        if (error is SecurityException) {
            call.reject("Folder access was denied. Choose the folder again and allow read and write access.", "permission-denied", error)
        } else {
            call.reject(error.message ?: "Local file operation failed", (error as? NativeFileException)?.code, error)
        }
    }

    @Synchronized
    fun open(call: PluginCall) {
        try {
            check(!disposed) { "Local file access is closed" }
            val id = id(call)
            require(!sessions.containsKey(id)) { "File endpoint already exists" }
            sessions[id] = Session(NativeFilesEndpoint(File(context.filesDir, "Documents"), context.cacheDir))
            call.resolve()
        } catch (error: Exception) { reject(call, error) }
    }

    @Synchronized
    fun call(call: PluginCall) {
        try {
            val session = sessions[id(call)] ?: throw NativeFileException("Unknown file endpoint")
            val method = call.getString("method") ?: throw NativeFileException("Missing file operation")
            val params = call.getObject("params") ?: throw NativeFileException("Missing file parameters")
            if (method == "abort") session.endpoint.stop(params.getString("transferId") ?: "")
            session.worker.execute {
                try { call.resolve(JSObject.fromJSONObject(session.endpoint.call(method, params, call.getString("data")))) }
                catch (error: Exception) { reject(call, error) }
            }
        } catch (error: Exception) { reject(call, error) }
    }

    @Synchronized
    fun choose(call: PluginCall, launch: (Intent, (ActivityResult) -> Unit) -> (() -> Unit)) {
        try {
            val id = id(call)
            val session = sessions[id] ?: throw NativeFileException("Unknown file endpoint")
            session.endpoint.checkOpen()
            val pending = picker.begin(id, call)
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
            }
            try { pending.unregister = launch(intent) { result -> selected(pending, result) } }
            catch (error: Exception) { picker.finish(pending); throw error }
        } catch (error: Exception) { reject(call, error) }
    }

    @Synchronized
    private fun selected(request: NativeFilePicker.Request<PluginCall>, result: ActivityResult) {
        val pending = picker.finish(request) ?: return
        val call = pending.value
        val session = sessions[pending.owner]
        val uri = result.data?.data
        if (session == null || result.resultCode != Activity.RESULT_OK || uri == null) {
            call.resolve(JSObject().put("value", JSONObject.NULL))
            return
        }
        val requiredAccess = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        if (((result.data?.flags ?: 0) and requiredAccess) != requiredAccess) {
            reject(call, SecurityException("The selected folder did not grant read and write access"))
            return
        }
        // Do not persist grants: endpoint/account closure discards the capability and a
        // subsequent account must select its own tree. Android owns temporary URI grants.
        session.worker.execute {
            try {
                val document = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
                call.resolve(JSObject().put("value", session.endpoint.select(DocumentFileNode(context.contentResolver, document))))
            }
            catch (error: Exception) { reject(call, error) }
        }
    }

    @Synchronized
    fun close(call: PluginCall) {
        try {
            val id = id(call)
            cancelPicker(id)
            val session = sessions.remove(id)
            if (session == null) { call.resolve(); return }
            session.endpoint.stopAll()
            session.worker.execute {
                try { session.endpoint.close(); call.resolve() }
                catch (error: Exception) { reject(call, error) }
            }
            session.worker.shutdown()
        } catch (error: Exception) { reject(call, error) }
    }

    private fun cancelPicker(id: String) {
        picker.cancel(id)?.let {
            it.value.resolve(JSObject().put("value", JSONObject.NULL))
        }
    }

    @Synchronized
    fun dispose() {
        disposed = true
        sessions.forEach { (id, session) ->
            cancelPicker(id)
            session.endpoint.stopAll()
            session.worker.execute { runCatching { session.endpoint.close() } }
            session.worker.shutdown()
        }
        sessions.clear()
    }
}
