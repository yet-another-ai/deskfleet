package io.github.yet_another_ai.deskfleet.nativedesktop

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

internal class LoopbackAuthServer(
    private val returnAppUri: String = "ai.yetanother.deskfleet://auth/callback",
) : AutoCloseable {
    private val serverSocket = ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))
    val port: Int = serverSocket.localPort
    val callbackUrl: String = "http://127.0.0.1:$port/auth/callback"
    private val origin = "http://127.0.0.1:$port"

    private sealed interface Outcome {
        data class Code(val value: String) : Outcome
        data class Failure(val error: Throwable) : Outcome
    }

    private val latch = CountDownLatch(1)
    private val outcome = AtomicReference<Outcome?>(null)

    init {
        thread(name = "deskfleet-loopback-auth", isDaemon = true) {
            acceptLoop()
        }
    }

    fun awaitCode(timeoutMs: Long = 300_000L): String {
        try {
            if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                throw TimeoutException("Sign-in timed out")
            }
            return when (val result = outcome.get()) {
                is Outcome.Code -> result.value
                is Outcome.Failure -> throw result.error
                null -> throw IllegalStateException("Sign-in cancelled")
            }
        } finally {
            close()
        }
    }

    override fun close() {
        runCatching { serverSocket.close() }
        if (outcome.compareAndSet(null, Outcome.Failure(IllegalStateException("Sign-in cancelled")))) {
            latch.countDown()
        }
    }

    private fun finish(result: Outcome) {
        if (outcome.compareAndSet(null, result)) {
            latch.countDown()
            runCatching { serverSocket.close() }
        }
    }

    private fun acceptLoop() {
        while (!serverSocket.isClosed && latch.count > 0) {
            val socket = try {
                serverSocket.accept()
            } catch (_: Exception) {
                break
            }
            try {
                socket.use { handleClient(it) }
            } catch (_: Exception) {
                // Ignore individual socket errors and continue waiting until POST /auth/complete or timeout.
            }
        }
    }

    private fun handleClient(socket: Socket) {
        socket.soTimeout = 10_000
        val input = socket.getInputStream()
        val output = socket.getOutputStream()

        val headerLines = readHeaderLines(input) ?: return
        val requestLine = headerLines.firstOrNull()?.split(' ') ?: return
        if (requestLine.size < 2) return
        val method = requestLine[0]
        val path = requestLine[1]

        val headers = mutableMapOf<String, String>()
        for (i in 1 until headerLines.size) {
            val line = headerLines[i]
            val colon = line.indexOf(':')
            if (colon > 0) {
                headers[line.substring(0, colon).trim().lowercase(Locale.ROOT)] =
                    line.substring(colon + 1).trim()
            }
        }

        if (method == "GET" && (path == "/auth/callback" || path.startsWith("/auth/callback?"))) {
            val html = """<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeskFleet</title><body><p id="status">Signing in…</p><form method="post" action="/auth/complete"><input type="hidden" name="code"></form><script>const code=new URLSearchParams(location.hash.slice(1)).get('loginCode');history.replaceState(null,'','/auth/callback');if(code){const form=document.querySelector('form');form.elements.code.value=code;form.submit();}else document.getElementById('status').textContent='Sign-in failed.';</script></body></html>"""
            val bodyBytes = html.toByteArray(StandardCharsets.UTF_8)
            val responseHeader = buildString {
                append("HTTP/1.1 200 OK\r\n")
                append("Content-Type: text/html; charset=utf-8\r\n")
                append("Cache-Control: no-store\r\n")
                append("Referrer-Policy: same-origin\r\n")
                append("Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; form-action 'self'\r\n")
                append("Content-Length: ${bodyBytes.size}\r\n")
                append("Connection: close\r\n\r\n")
            }
            output.write(responseHeader.toByteArray(StandardCharsets.UTF_8))
            output.write(bodyBytes)
            output.flush()
            return
        }

        if (method != "POST" || path != "/auth/complete" || headers["origin"] != origin) {
            val notFound = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            output.write(notFound.toByteArray(StandardCharsets.UTF_8))
            output.flush()
            return
        }

        try {
            val contentLength = headers["content-length"]?.toIntOrNull()
                ?: throw IllegalArgumentException("Invalid login response")
            if (contentLength !in 1..8192) {
                throw IllegalArgumentException("Invalid login response")
            }
            val bodyBytes = readExactBytes(input, contentLength)
            val body = String(bodyBytes, StandardCharsets.UTF_8)
            val loginCode = extractFormField(body, "code")?.takeIf { it.isNotEmpty() }
                ?: throw IllegalArgumentException("Missing login code")

            val doneHtml = """<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeskFleet</title><body><p>Signed in. <a href="$returnAppUri">Return to DeskFleet</a></p></body></html>"""
            val doneBytes = doneHtml.toByteArray(StandardCharsets.UTF_8)
            val responseHeader = buildString {
                append("HTTP/1.1 303 See Other\r\n")
                append("Location: $returnAppUri\r\n")
                append("Content-Type: text/html; charset=utf-8\r\n")
                append("Cache-Control: no-store\r\n")
                append("Content-Length: ${doneBytes.size}\r\n")
                append("Connection: close\r\n\r\n")
            }
            output.write(responseHeader.toByteArray(StandardCharsets.UTF_8))
            output.write(doneBytes)
            output.flush()
            finish(Outcome.Code(loginCode))
        } catch (error: Exception) {
            val failBytes = "Sign-in failed.".toByteArray(StandardCharsets.UTF_8)
            val responseHeader = buildString {
                append("HTTP/1.1 400 Bad Request\r\n")
                append("Content-Type: text/plain; charset=utf-8\r\n")
                append("Cache-Control: no-store\r\n")
                append("Content-Length: ${failBytes.size}\r\n")
                append("Connection: close\r\n\r\n")
            }
            runCatching {
                output.write(responseHeader.toByteArray(StandardCharsets.UTF_8))
                output.write(failBytes)
                output.flush()
            }
            finish(Outcome.Failure(error))
        }
    }

    private fun readHeaderLines(input: InputStream): List<String>? {
        val buffer = ByteArrayOutputStream()
        var matched = 0
        while (buffer.size() < 16_384) {
            val b = input.read()
            if (b == -1) return null
            buffer.write(b)
            matched = when {
                (matched == 0 || matched == 2) && b == '\r'.code -> matched + 1
                (matched == 1 || matched == 3) && b == '\n'.code -> matched + 1
                b == '\r'.code -> 1
                else -> 0
            }
            if (matched == 4) {
                val raw = String(buffer.toByteArray(), StandardCharsets.UTF_8)
                return raw.split("\r\n").filter { it.isNotEmpty() }
            }
        }
        return null
    }

    private fun readExactBytes(input: InputStream, length: Int): ByteArray {
        val result = ByteArray(length)
        var offset = 0
        while (offset < length) {
            val read = input.read(result, offset, length - offset)
            if (read == -1) throw IllegalArgumentException("Invalid login response")
            offset += read
        }
        return result
    }

    private fun extractFormField(body: String, key: String): String? {
        for (pair in body.split('&')) {
            val eq = pair.indexOf('=')
            if (eq <= 0) continue
            val name = URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8.name())
            if (name == key) {
                return URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8.name())
            }
        }
        return null
    }
}
