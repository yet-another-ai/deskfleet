package io.github.yet_another_ai.deskfleet.nativedesktop

import org.junit.Assert.assertEquals
import org.junit.Test

class FirebaseTelemetryBridgeTest {
    @Test
    fun sanitizesIdentifiersToFirebaseRules() {
        assertEquals("account_registered", FirebaseTelemetryBridge.sanitizeIdentifier("account_registered"))
        assertEquals("marketing_page_viewed", FirebaseTelemetryBridge.sanitizeIdentifier("marketing-page.viewed"))
        assertEquals("_123_start", FirebaseTelemetryBridge.sanitizeIdentifier("123-start"))
        assertEquals("event", FirebaseTelemetryBridge.sanitizeIdentifier("   "))
        val longName = "a".repeat(60)
        assertEquals(40, FirebaseTelemetryBridge.sanitizeIdentifier(longName).length)
    }
}
