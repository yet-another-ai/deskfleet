package io.github.yet_another_ai.deskfleet.nativedesktop

import android.content.ContentResolver
import android.database.Cursor
import android.net.Uri
import android.provider.DocumentsContract
import java.io.InputStream
import java.io.OutputStream

internal class DocumentFileNode(private val resolver: ContentResolver, private val uri: Uri) : NativeFileNode {
    private val columns = arrayOf(
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_SIZE,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        DocumentsContract.Document.COLUMN_FLAGS,
    )

    private fun metadata(cursor: Cursor): NativeFileInfo {
        val flags = cursor.getInt(5)
        require(flags and DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT == 0) { "Virtual documents are unsupported" }
        val directory = cursor.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR
        // A provider without a known length cannot participate in the byte-counted transfer protocol.
        require(directory || (!cursor.isNull(3) && cursor.getLong(3) >= 0)) { "The document provider has not supplied a file size" }
        return NativeFileInfo(cursor.getString(1), directory, if (directory) 0 else cursor.getLong(3), cursor.getLong(4), cursor.getString(0))
    }

    override fun info(): NativeFileInfo = resolver.query(uri, columns, null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst()) throw NativeFileException("File no longer exists")
        metadata(cursor)
    } ?: throw NativeFileException("Cannot read this document")

    override fun children(): List<NativeFileNode> {
        require(info().directory) { "A folder is required" }
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(uri, DocumentsContract.getDocumentId(uri))
        return resolver.query(children, columns, null, null, null)?.use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    val id = cursor.getString(0)
                    add(DocumentFileNode(resolver, DocumentsContract.buildDocumentUriUsingTree(uri, id)))
                }
            }
        } ?: throw NativeFileException("Cannot read this folder")
    }

    override fun child(name: String): NativeFileNode? {
        NativeFilePaths.name(name)
        require(info().directory) { "A folder is required" }
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(uri, DocumentsContract.getDocumentId(uri))
        val names = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        val cursor = resolver.query(children, names, null, null, null) ?: throw NativeFileException("Cannot read this folder")
        return cursor.use {
            var found: NativeFileNode? = null
            while (cursor.moveToNext()) {
                if (cursor.getString(1) == name) {
                    found = DocumentFileNode(resolver, DocumentsContract.buildDocumentUriUsingTree(uri, cursor.getString(0)))
                    break
                }
            }
            found
        }
    }

    override fun create(name: String, directory: Boolean): NativeFileNode {
        NativeFilePaths.name(name)
        val mime = if (directory) DocumentsContract.Document.MIME_TYPE_DIR else "application/octet-stream"
        val created = DocumentsContract.createDocument(resolver, uri, mime, name)
            ?: throw NativeFileException("The document provider could not create this entry")
        val node = DocumentFileNode(resolver, created)
        // Providers may choose a different name after a concurrent creation. Keep the created
        // entry rather than deleting a document that could already have been changed externally.
        if (node.info().name != name) throw NativeFileException("The document provider changed the destination name. A created entry was kept; refresh the folder.", "partial_copy")
        return node
    }

    override fun input(): InputStream = resolver.openInputStream(uri)
        ?: throw NativeFileException("Cannot open this file for reading")

    override fun output(): OutputStream = resolver.openOutputStream(uri, "wt")
        ?: throw NativeFileException("Cannot open this file for writing")
}
