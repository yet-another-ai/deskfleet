package io.github.yet_another_ai.deskfleet.nativedesktop

import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes

internal class NativeFileException(message: String, val code: String? = null) : Exception(message)

internal object NativeFilePaths {
    fun segments(path: String): List<String> {
        if (path.isEmpty()) return emptyList()
        return path.split('/').also { parts ->
            require(parts.none { it.isEmpty() || it == "." || it == ".." || it.any { ch -> ch == '\\' || ch == ':' || ch == '\u0000' } }) {
                "Invalid transfer path"
            }
        }
    }

    fun name(name: String): String {
        require(segments(name).size == 1) { "Invalid file name" }
        return name
    }

    fun renamed(name: String, directory: Boolean, index: Int): String {
        val dot = if (directory) -1 else name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val extension = if (dot > 0) name.substring(dot) else ""
        return "$stem ($index)$extension"
    }
}

internal data class NativeFileInfo(val name: String, val directory: Boolean, val size: Long, val modifiedAt: Long, val identity: String)

/** Nodes are capabilities rooted in Documents or a tree selected by the user, never arbitrary OS paths. */
internal interface NativeFileNode {
    fun info(): NativeFileInfo
    fun children(): List<NativeFileNode>
    fun child(name: String): NativeFileNode? = children().firstOrNull { it.info().name == name }
    fun create(name: String, directory: Boolean): NativeFileNode
    fun input(): InputStream
    fun output(): OutputStream
}

internal class LocalFileNode(private val root: File, private val file: File = root) : NativeFileNode {
    private fun checked(): File {
        val base = root.canonicalFile.toPath()
        val candidate = file.canonicalFile.toPath()
        require(candidate == base || candidate.startsWith(base)) { "File is outside the selected folder" }
        require(!Files.isSymbolicLink(file.toPath())) { "Symbolic links are unsupported" }
        return file
    }

    override fun info(): NativeFileInfo {
        val path = checked().toPath()
        val attrs = Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        require(attrs.isDirectory || attrs.isRegularFile) { "Unsupported file type" }
        return NativeFileInfo(file.name, attrs.isDirectory, if (attrs.isDirectory) 0 else attrs.size(), attrs.lastModifiedTime().toMillis(), attrs.fileKey()?.toString() ?: path.toString())
    }

    override fun children(): List<NativeFileNode> {
        require(info().directory) { "A folder is required" }
        return (checked().listFiles() ?: throw NativeFileException("Cannot read this folder")).map { LocalFileNode(root, it) }
    }

    override fun child(name: String): NativeFileNode? {
        NativeFilePaths.name(name)
        require(info().directory) { "A folder is required" }
        val child = File(checked(), name)
        return if (Files.exists(child.toPath(), LinkOption.NOFOLLOW_LINKS)) LocalFileNode(root, child) else null
    }

    override fun create(name: String, directory: Boolean): NativeFileNode {
        NativeFilePaths.name(name)
        require(info().directory) { "A folder is required" }
        val child = File(checked(), name)
        if (directory) Files.createDirectory(child.toPath()) else Files.createFile(child.toPath())
        return LocalFileNode(root, child)
    }

    override fun input(): InputStream {
        require(!info().directory) { "A file is required" }
        return checked().inputStream()
    }

    override fun output(): OutputStream {
        require(!info().directory) { "A file is required" }
        return checked().outputStream()
    }
}
