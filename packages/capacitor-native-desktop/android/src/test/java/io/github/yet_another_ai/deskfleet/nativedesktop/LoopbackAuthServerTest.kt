package io.github.yet_another_ai.deskfleet.nativedesktop

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.Socket
import java.nio.charset.StandardCharsets

class LoopbackAuthServerTest {
    private fun rawHttpRequest(port: Int, request: String): String {
        Socket("127.0.0.1", port).use { socket ->
            socket.getOutputStream().write(request.toByteArray(StandardCharsets.UTF_8))
            socket.getOutputStream().flush()
            return socket.getInputStream().bufferedReader(StandardCharsets.UTF_8).readText()
        }
    }

    @Test
    fun servesCallbackHtmlAndCompletesWithPostedCode() {
        LoopbackAuthServer().use { server ->
            val callbackResponse = rawHttpRequest(
                server.port,
                "GET /auth/callback HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n",
            )
            assertTrue(callbackResponse.startsWith("HTTP/1.1 200 OK\r\n"))
            assertTrue(callbackResponse.contains("/auth/complete"))

            val faviconResponse = rawHttpRequest(
                server.port,
                "GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n",
            )
            assertTrue(faviconResponse.startsWith("HTTP/1.1 404 Not Found\r\n"))

            val body = "code=login-code-123"
            val completeResponse = rawHttpRequest(
                server.port,
                buildString {
                    append("POST /auth/complete HTTP/1.1\r\n")
                    append("Host: 127.0.0.1:${server.port}\r\n")
                    append("Origin: http://127.0.0.1:${server.port}\r\n")
                    append("Content-Type: application/x-www-form-urlencoded\r\n")
                    append("Content-Length: ${body.length}\r\n\r\n")
                    append(body)
                },
            )
            assertTrue(completeResponse.startsWith("HTTP/1.1 303 See Other\r\n"))
            assertTrue(completeResponse.contains("Location: ai.yetanother.deskfleet://auth/callback\r\n"))
            assertEquals("login-code-123", server.awaitCode(5_000L))
        }
    }
}
