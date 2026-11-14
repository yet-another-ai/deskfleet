package io.github.yet_another_ai.deskfleet.nativedesktop

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** One serial worker owns I/O; cancellation flags can be set while a commit is copying. */
internal class NativeFilesEndpoint(documents: File, cache: File) {
    private data class Root(val name: String, val node: NativeFileNode)
    private data class Read(val path: String, val node: NativeFileNode, val info: NativeFileInfo, var input: InputStream, var offset: Long = 0)
    private data class Write(val stream: OutputStream, var offset: Long = 0)
    private class Upload(val destination: NativeFileNode, val directoryPath: String, val requestedName: String, var name: String, val directory: Boolean, val conflict: String, val stage: File) {
        val stopped = AtomicBoolean()
        val writes = mutableMapOf<String, Write>()
        val finished = mutableSetOf<String>()
    }

    private val roots = linkedMapOf<String, Root>()
    private val reads = mutableMapOf<String, Read>()
    private val uploads = ConcurrentHashMap<String, Upload>()
    private val closed = AtomicBoolean()
    private val staging = Files.createTempDirectory(cache.toPath(), "deskfleet-files-").toFile()
    private var selected = "/Documents"

    init {
        Files.createDirectories(documents.toPath())
        roots[selected] = Root("Documents", LocalFileNode(documents))
    }

    fun checkOpen() { check(!closed.get()) { "Local file access is closed" } }

    fun select(node: NativeFileNode): JSONObject {
        checkOpen()
        val info = node.info()
        require(info.directory) { "A folder is required" }
        // Display labels never expose provider URIs or filesystem paths to the WebView.
        val label = info.name.replace(Regex("[/\\\\:\u0000]"), "_").ifBlank { "Folder" }
        var path = "/$label"
        var index = 2
        while (roots.containsKey(path)) path = "/$label (${index++})"
        val previous = selected
        roots[path] = Root(info.name, node)
        selected = path
        try { return listing(path, false) }
        catch (error: Exception) {
            roots.remove(path)
            selected = previous
            throw error
        }
    }

    private fun node(path: String): NativeFileNode {
        val root = roots.keys.filter { path == it || path.startsWith("$it/") }.maxByOrNull { it.length }
            ?: throw NativeFileException("Choose a local folder first")
        var current = roots.getValue(root).node
        for (part in NativeFilePaths.segments(path.removePrefix(root).removePrefix("/"))) {
            current = current.child(part) ?: throw NativeFileException("File no longer exists")
        }
        return current
    }

    private fun entry(path: String, info: NativeFileInfo): JSONObject = JSONObject()
        .put("path", path).put("name", info.name).put("kind", if (info.directory) "directory" else "file")
        .put("size", info.size).put("modifiedAt", info.modifiedAt)

    private fun listing(path: String, strict: Boolean): JSONObject {
        val entries = node(path).children().mapNotNull { child ->
            try {
                val info = child.info()
                NativeFilePaths.name(info.name)
                info
            } catch (error: Exception) { if (strict) throw error else null }
        }.sortedWith(compareByDescending<NativeFileInfo> { it.directory }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
        return JSONObject().put("path", path)
            .put("parentPath", if (roots.containsKey(path)) JSONObject.NULL else path.substringBeforeLast('/'))
            .put("homePath", selected)
            .put("roots", JSONArray(roots.map { (path, root) -> JSONObject().put("path", path).put("name", root.name) }))
            .put("entries", JSONArray(entries.map { entry("$path/${it.name}", it) }))
    }

    private fun conflict(): Nothing = throw NativeFileException("A file or folder with this name already exists", "conflict")

    private fun unusedName(directory: NativeFileNode, name: String, isDirectory: Boolean): String {
        var candidate = name
        var index = 1
        while (directory.child(candidate) != null) candidate = NativeFilePaths.renamed(name, isDirectory, index++)
        return candidate
    }

    private fun number(params: JSONObject, name: String): Long {
        val value = params.getDouble(name)
        require(value.isFinite() && value >= 0 && value <= 9_007_199_254_740_991.0 && value % 1.0 == 0.0) { "Invalid $name" }
        return value.toLong()
    }

    private fun openRead(params: JSONObject): Read {
        val path = params.getString("path")
        val source = node(path)
        val info = source.info()
        require(!info.directory) { "A file is required" }
        if (params.has("modifiedAt") && number(params, "modifiedAt") != info.modifiedAt) throw NativeFileException("File changed during transfer")
        return Read(path, source, info, source.input())
    }

    private fun validate(read: Read) {
        val info = node(read.path).info()
        if (info.directory || info.identity != read.info.identity || info.size != read.info.size || info.modifiedAt != read.info.modifiedAt) {
            throw NativeFileException("File changed during transfer")
        }
    }

    private fun read(params: JSONObject): JSONObject {
        val offset = number(params, "offset")
        val length = number(params, "length")
        require(length <= CHUNK_BYTES) { "Invalid file read" }
        val readId = params.optString("readId").takeIf { it.isNotEmpty() }
        val read = if (readId == null) openRead(params) else reads[readId] ?: throw NativeFileException("Unknown file read")
        try {
            require(params.getString("path") == read.path) { "File read path does not match its session" }
            if (params.has("modifiedAt") && number(params, "modifiedAt") != read.info.modifiedAt) throw NativeFileException("File changed during transfer")
            validate(read)
            val position = offset.coerceAtMost(read.info.size)
            if (position < read.offset) {
                read.input.close()
                read.input = read.node.input()
                read.offset = 0
            }
            while (read.offset < position) {
                checkOpen()
                val skipped = read.input.skip(position - read.offset)
                if (skipped > 0) read.offset += skipped
                else {
                    if (read.input.read() == -1) throw NativeFileException("File changed during transfer")
                    read.offset++
                }
            }
            val bytes = ByteArray(minOf(length, read.info.size - position).toInt())
            var received = 0
            while (received < bytes.size) {
                checkOpen()
                val count = read.input.read(bytes, received, bytes.size - received)
                if (count < 0) throw NativeFileException("File changed during transfer")
                received += count
                read.offset += count
            }
            validate(read)
            return reply(JSONObject().put("bytes", received)).put("data", Base64.getEncoder().encodeToString(bytes))
        } finally { if (readId == null) read.input.close() }
    }

    private fun upload(params: JSONObject): Upload = uploads[params.getString("transferId")]
        ?.also { check(!it.stopped.get()) { "File transfer was cancelled" } }
        ?: throw NativeFileException("Unknown file transfer")

    private fun stageFile(upload: Upload, path: String): File {
        NativeFilePaths.segments(path)
        if (!upload.directory) {
            require(path.isEmpty()) { "Invalid root file path" }
            return File(upload.stage, "file")
        }
        require(path.isNotEmpty()) { "A file path is required" }
        return File(File(upload.stage, "directory"), path)
    }

    private fun begin(params: JSONObject): JSONObject {
        val directoryPath = params.optString("directory").takeIf { it.isNotEmpty() }
            ?: throw NativeFileException("Session attachments belong to the executing machine")
        val name = NativeFilePaths.name(params.getString("name"))
        val kind = params.getString("kind")
        require(kind == "file" || kind == "directory") { "Invalid file kind" }
        val isDirectory = kind == "directory"
        val conflict = params.getString("conflict")
        require(conflict in listOf("ask", "skip", "rename", "replace")) { "Invalid conflict policy" }
        val destination = node(directoryPath)
        require(destination.info().directory) { "A destination folder is required" }
        val existing = destination.child(name)
        if (existing != null && conflict == "skip") return reply(JSONObject().put("transferId", "").put("skipped", true))
        if (existing != null && conflict == "ask") conflict()
        if (existing != null && conflict == "replace" && (isDirectory || existing.info().directory)) {
            throw NativeFileException("Replacing an existing folder is unsupported. Keep both instead.", "conflict")
        }
        val targetName = if (conflict == "rename") unusedName(destination, name, isDirectory) else name
        val id = UUID.randomUUID().toString()
        val stage = Files.createTempDirectory(staging.toPath(), "transfer-").toFile()
        if (isDirectory) Files.createDirectory(File(stage, "directory").toPath())
        uploads[id] = Upload(destination, directoryPath, name, targetName, isDirectory, conflict, stage)
        return reply(JSONObject().put("transferId", id).put("skipped", false))
    }

    private fun copy(upload: Upload, source: File, destination: NativeFileNode) {
        checkOpen()
        check(!upload.stopped.get()) { "File transfer was cancelled" }
        if (source.isDirectory) {
            val children = source.listFiles() ?: throw NativeFileException("Cannot read transfer staging")
            for (child in children) {
                checkOpen()
                check(!upload.stopped.get()) { "File transfer was cancelled" }
                copy(upload, child, destination.create(child.name, child.isDirectory))
            }
        } else {
            source.inputStream().use { input ->
                destination.output().use { output ->
                    val buffer = ByteArray(CHUNK_BYTES)
                    while (true) {
                        checkOpen()
                        check(!upload.stopped.get()) { "File transfer was cancelled" }
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                    }
                }
            }
        }
    }

    private fun commit(params: JSONObject): JSONObject {
        val id = params.getString("transferId")
        val upload = upload(params)
        require(upload.writes.isEmpty()) { "Transfer has unfinished files" }
        if (!upload.directory) require(upload.finished.contains("")) { "Transfer has no completed file" }
        var existing = upload.destination.child(upload.name)
        if (existing != null && upload.conflict == "skip") {
            remove(id)
            return reply(JSONObject().put("path", "${upload.directoryPath}/${upload.name}").put("skipped", true))
        }
        if (upload.conflict == "rename") {
            upload.name = unusedName(upload.destination, upload.requestedName, upload.directory)
            existing = null
        }
        if (existing != null && (upload.conflict != "replace" || upload.directory || existing.info().directory)) conflict()
        checkOpen()
        check(!upload.stopped.get()) { "File transfer was cancelled" }
        try {
            // SAF has no atomic publish across arbitrary document providers. Keep already
            // published entries on failure; deleting them could remove another app's edits.
            val destination = existing ?: upload.destination.create(upload.name, upload.directory)
            copy(upload, File(upload.stage, if (upload.directory) "directory" else "file"), destination)
        } catch (error: Exception) {
            throw NativeFileException("Copy did not finish. Files already saved in the destination have been kept. ${error.message.orEmpty()}", "partial_copy")
        }
        remove(id)
        return reply(JSONObject().put("path", "${upload.directoryPath}/${upload.name}"))
    }

    fun call(method: String, params: JSONObject, encoded: String?): JSONObject {
        checkOpen()
        return when (method) {
            "list" -> reply(listing(params.optString("path").takeIf { it.isNotEmpty() } ?: selected, params.optBoolean("strict")))
            "stat" -> params.getString("path").let { reply(entry(it, node(it).info())) }
            "resolve" -> throw NativeFileException("Agent resources belong to the executing machine")
            "openRead" -> {
                require(reads.size < 32) { "Too many open file reads" }
                val read = openRead(params)
                val id = UUID.randomUUID().toString()
                reads[id] = read
                reply(JSONObject().put("readId", id))
            }
            "read" -> read(params)
            "closeRead" -> {
                reads.remove(params.getString("readId"))?.let { read ->
                    try { validate(read) } finally { read.input.close() }
                }
                reply()
            }
            "begin" -> begin(params)
            "mkdir" -> {
                val upload = upload(params)
                require(upload.directory) { "A directory transfer is required" }
                val path = params.getString("path")
                NativeFilePaths.segments(path)
                Files.createDirectories(File(File(upload.stage, "directory"), path).toPath())
                reply()
            }
            "write" -> {
                val upload = upload(params)
                val path = params.getString("path")
                val file = stageFile(upload, path)
                val offset = number(params, "offset")
                require(encoded != null && encoded.length <= ((CHUNK_BYTES + 2) / 3) * 4) { "Invalid file write" }
                val data = Base64.getDecoder().decode(encoded)
                require(data.size <= CHUNK_BYTES && path !in upload.finished) { "Invalid file write" }
                val write = upload.writes[path] ?: run {
                    require(offset == 0L) { "File writes must start at zero" }
                    Write(file.outputStream()).also { upload.writes[path] = it }
                }
                require(write.offset == offset) { "File writes must be sequential" }
                write.stream.write(data)
                write.offset += data.size
                reply(JSONObject().put("bytes", data.size))
            }
            "finish" -> {
                val upload = upload(params)
                val path = params.getString("path")
                val write = upload.writes[path] ?: throw NativeFileException("Transfer has no open file")
                require(write.offset == number(params, "size")) { "File size does not match the received bytes" }
                write.stream.close()
                upload.writes.remove(path)
                upload.finished.add(path)
                reply()
            }
            "commit" -> commit(params)
            "abort" -> { remove(params.getString("transferId")); reply() }
            else -> throw NativeFileException("Unknown file operation")
        }
    }

    /** Called on the bridge thread before its cleanup operation joins the serial I/O queue. */
    fun stop(transferId: String) { uploads[transferId]?.stopped?.set(true) }
    fun stopAll() { closed.set(true); uploads.values.forEach { it.stopped.set(true) } }

    private fun remove(id: String) {
        val upload = uploads.remove(id) ?: return
        upload.writes.values.forEach { runCatching { it.stream.close() } }
        check(upload.stage.deleteRecursively()) { "Could not remove transfer staging" }
    }

    fun close() {
        stopAll()
        reads.values.forEach { runCatching { it.input.close() } }
        reads.clear()
        uploads.keys.toList().forEach(::remove)
        roots.clear()
        check(staging.deleteRecursively()) { "Could not remove file staging" }
    }

    private fun reply(value: Any = JSONObject.NULL): JSONObject = JSONObject().put("value", value)

    companion object { private const val CHUNK_BYTES = 127 * 1024 }
}
