package io.github.yet_another_ai.deskfleet.nativedesktop

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.OutputStream
import java.nio.file.Files
import java.util.Base64

class NativeFilesEndpointTest {
    private val temporary = Files.createTempDirectory("deskfleet-native-files-test").toFile()
    private val documents = File(temporary, "Documents")
    private val endpoint = NativeFilesEndpoint(documents, temporary)

    @After
    fun cleanup() { endpoint.close(); temporary.deleteRecursively() }

    private fun params(vararg values: Pair<String, Any>): JSONObject = JSONObject().apply { values.forEach { put(it.first, it.second) } }
    private fun call(method: String, vararg values: Pair<String, Any>): Any = endpoint.call(method, params(*values), null).get("value")
    private fun begin(name: String, kind: String = "file", conflict: String = "ask", directory: String = "/Documents"): String =
        (call("begin", "directory" to directory, "name" to name, "kind" to kind, "conflict" to conflict) as JSONObject).getString("transferId")
    private fun write(id: String, bytes: ByteArray, path: String = "", offset: Long = 0) = endpoint.call(
        "write", params("transferId" to id, "path" to path, "offset" to offset), Base64.getEncoder().encodeToString(bytes),
    )
    private fun finish(id: String, size: Long, path: String = "") { call("finish", "transferId" to id, "path" to path, "size" to size) }
    private fun publish(id: String) = call("commit", "transferId" to id) as JSONObject

    @Test
    fun defaultDocumentsCanReceiveAndReadBinaryWithoutChoosingAFolder() {
        val listing = call("list") as JSONObject
        assertEquals("/Documents", listing.getString("path"))
        assertTrue(listing.isNull("parentPath"))
        val bytes = byteArrayOf(0, 1, 127, -128, -1)
        val id = begin("sample.bin")
        write(id, bytes)
        finish(id, bytes.size.toLong())
        assertFalse(File(documents, "sample.bin").exists())
        assertEquals("/Documents/sample.bin", publish(id).getString("path"))
        val readId = (call("openRead", "path" to "/Documents/sample.bin") as JSONObject).getString("readId")
        val reply = endpoint.call("read", params("readId" to readId, "path" to "/Documents/sample.bin", "offset" to 1, "length" to 3), null)
        assertArrayEquals(bytes.sliceArray(1..3), Base64.getDecoder().decode(reply.getString("data")))
        call("closeRead", "readId" to readId)
    }

    @Test
    fun sourceMutationFailsFinalReadValidation() {
        File(documents, "changing.txt").writeText("before")
        val readId = (call("openRead", "path" to "/Documents/changing.txt") as JSONObject).getString("readId")
        File(documents, "changing.txt").writeText("changed length")
        assertThrows(NativeFileException::class.java) { call("closeRead", "readId" to readId) }
        // The failed close still releases the read handle.
        call("closeRead", "readId" to readId)
    }

    @Test
    fun directoryTransfersPreserveNestedFilesAndEmptyFolders() {
        val id = begin("folder", "directory")
        call("mkdir", "transferId" to id, "path" to "nested/empty")
        write(id, byteArrayOf(), "nested/zero")
        finish(id, 0, "nested/zero")
        publish(id)
        assertTrue(File(documents, "folder/nested/empty").isDirectory)
        assertEquals(0L, File(documents, "folder/nested/zero").length())
        assertTrue(File(documents, "folder/nested/zero").isFile)
    }

    @Test
    fun writeOffsetsAndFinishingAreCheckedBeforePublication() {
        val id = begin("data")
        assertThrows(IllegalArgumentException::class.java) { write(id, byteArrayOf(1), offset = 1) }
        write(id, byteArrayOf(1))
        assertThrows(IllegalArgumentException::class.java) { write(id, byteArrayOf(2), offset = 0) }
        assertThrows(IllegalArgumentException::class.java) { finish(id, 2) }
        assertThrows(IllegalArgumentException::class.java) { publish(id) }
        write(id, byteArrayOf(2), offset = 1)
        finish(id, 2)
        publish(id)
        assertArrayEquals(byteArrayOf(1, 2), File(documents, "data").readBytes())
    }

    @Test
    fun traversalAndOversizedChunksCannotWriteOutsideStaging() {
        val id = begin("folder", "directory")
        for (path in listOf("../escape", "/escape", "a//b", "a/./b", "a\\b", "a:b", "a\u0000b")) {
            assertThrows(IllegalArgumentException::class.java) { call("mkdir", "transferId" to id, "path" to path) }
        }
        assertThrows(IllegalArgumentException::class.java) { write(id, ByteArray(127 * 1024 + 1), "too-large") }
        assertThrows(NativeFileException::class.java) { call("stat", "path" to temporary.path) }
    }

    @Test
    fun conflictsPreserveExistingDataUntilAnExplicitChoice() {
        File(documents, "file.txt").writeText("old")
        assertEquals("conflict", assertThrows(NativeFileException::class.java) { begin("file.txt") }.code)
        assertEquals("", begin("file.txt", conflict = "skip"))
        val renamed = begin("file.txt", conflict = "rename")
        write(renamed, "new".toByteArray())
        finish(renamed, 3)
        // Another writer occupied the selected sibling between begin and commit.
        File(documents, "file (1).txt").writeText("other")
        assertEquals("/Documents/file (2).txt", publish(renamed).getString("path"))
        assertEquals("old", File(documents, "file.txt").readText())
        assertEquals("other", File(documents, "file (1).txt").readText())
        val replacement = begin("file.txt", conflict = "replace")
        write(replacement, "replaced".toByteArray())
        finish(replacement, 8)
        publish(replacement)
        assertEquals("replaced", File(documents, "file.txt").readText())
        File(documents, "folder").mkdir()
        assertEquals("conflict", assertThrows(NativeFileException::class.java) { begin("folder", "directory", "replace") }.code)
    }

    @Test
    fun abortAndCloseRemovePrivateStagingWithoutTouchingPublishedFiles() {
        File(documents, "keep").writeText("keep")
        val id = begin("cancelled")
        write(id, byteArrayOf(1, 2))
        endpoint.stop(id)
        assertThrows(IllegalStateException::class.java) { finish(id, 2) }
        call("abort", "transferId" to id)
        assertFalse(File(documents, "cancelled").exists())
        endpoint.close()
        assertEquals("keep", File(documents, "keep").readText())
        assertTrue(temporary.listFiles()!!.all { it == documents })
        assertThrows(IllegalStateException::class.java) { call("list") }
    }

    @Test
    fun deniedFolderSelectionKeepsThePreviousRootAndNoCapability() {
        val chosen = File(temporary, "Denied").also { it.mkdir() }
        val denied = object : NativeFileNode by LocalFileNode(chosen) {
            override fun children(): List<NativeFileNode> = throw SecurityException("Folder access revoked")
        }
        assertThrows(SecurityException::class.java) { endpoint.select(denied) }
        val listing = call("list") as JSONObject
        assertEquals("/Documents", listing.getString("path"))
        assertEquals("/Documents", listing.getString("homePath"))
        assertEquals(1, listing.getJSONArray("roots").length())
        assertThrows(NativeFileException::class.java) { call("stat", "path" to "/Denied") }
    }

    @Test
    fun freshEndpointCannotReuseAnotherEndpointsSelectedFolder() {
        val chosen = File(temporary, "Chosen").also { it.mkdir() }
        File(chosen, "private.txt").writeText("selected only in the first endpoint")
        endpoint.select(LocalFileNode(chosen))
        val next = NativeFilesEndpoint(documents, temporary)
        try {
            assertThrows(NativeFileException::class.java) {
                next.call("stat", params("path" to "/Chosen/private.txt"), null)
            }
            assertEquals("/Documents", next.call("list", params(), null).getJSONObject("value").getString("path"))
        } finally { next.close() }
    }

    @Test
    fun selectedFoldersAreCapabilitiesAndCancelledPublicationKeepsPartialFiles() {
        val chosen = File(temporary, "Chosen").also { it.mkdir() }
        var id = ""
        val node = object : NativeFileNode by LocalFileNode(chosen) {
            override fun create(name: String, directory: Boolean): NativeFileNode {
                val child = LocalFileNode(chosen).create(name, directory)
                return object : NativeFileNode by child {
                    override fun output(): OutputStream {
                        val stream = child.output()
                        return object : OutputStream() {
                            override fun write(value: Int) { stream.write(value); endpoint.stop(id) }
                            override fun write(bytes: ByteArray, offset: Int, length: Int) { stream.write(bytes, offset, length); endpoint.stop(id) }
                            override fun close() { stream.close() }
                        }
                    }
                }
            }
        }
        val listing = endpoint.select(node)
        assertEquals("/Chosen", listing.getString("path"))
        id = begin("partial", directory = "/Chosen")
        write(id, ByteArray(127 * 1024))
        write(id, byteArrayOf(1), offset = (127 * 1024).toLong())
        finish(id, (127 * 1024 + 1).toLong())
        assertEquals("partial_copy", assertThrows(NativeFileException::class.java) { publish(id) }.code)
        call("abort", "transferId" to id)
        assertEquals((127 * 1024).toLong(), File(chosen, "partial").length())
    }
}
