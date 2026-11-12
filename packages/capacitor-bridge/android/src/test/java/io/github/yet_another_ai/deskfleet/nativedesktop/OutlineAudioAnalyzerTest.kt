package io.github.yet_another_ai.deskfleet.nativedesktop

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

class OutlineAudioAnalyzerTest {
    @Test
    fun separatesStereoChannelsAndQuantizesDbSpectrum() {
        val sampleRate = 48_000
        val frames = OutlineAudioAnalyzer.FFT_SIZE
        val bins = OutlineAudioAnalyzer.SPECTRUM_BINS
        val analyzer = OutlineAudioAnalyzer()
        val spectrum = ByteArray(OutlineAudioAnalyzer.STEREO_SPECTRUM_BYTES)

        analyzer.pushInterleavedStereo(FloatArray(frames * 2), frames)
        assertFalse(analyzer.computeSpectrum(spectrum))
        assertTrue(spectrum.all { it.toInt() == 0 })

        // Feed a 440 Hz tone exclusively on the Left channel: only bins 0..223 light up.
        val leftTone = FloatArray(frames * 2)
        for (i in 0 until frames) {
            leftTone[i * 2] = (0.5 * sin(2.0 * PI * 440.0 * i / sampleRate)).toFloat()
        }
        analyzer.pushInterleavedStereo(leftTone, frames)
        assertTrue(analyzer.computeSpectrum(spectrum))
        val firstPeak = (0 until bins).maxOf { spectrum[it].toInt() and 0xFF }
        assertTrue(analyzer.computeSpectrum(spectrum))

        val leftPeak = (0 until bins).maxOf { spectrum[it].toInt() and 0xFF }
        val rightPeak = (bins until bins * 2).maxOf { spectrum[it].toInt() and 0xFF }
        assertTrue("Expected smoothing to build from $firstPeak to $leftPeak", leftPeak > firstPeak)
        assertTrue("Expected left peak > 200, got $leftPeak", leftPeak > 200)
        assertEquals(0, rightPeak)

        // Identical 440 Hz tone on the Right channel produces identical bin bytes.
        val rightAnalyzer = OutlineAudioAnalyzer()
        val rightTone = FloatArray(frames * 2)
        for (i in 0 until frames) {
            rightTone[i * 2 + 1] = (0.5 * sin(2.0 * PI * 440.0 * i / sampleRate)).toFloat()
        }
        rightAnalyzer.pushInterleavedStereo(rightTone, frames)
        val rightSpectrum = ByteArray(OutlineAudioAnalyzer.STEREO_SPECTRUM_BYTES)
        rightAnalyzer.computeSpectrum(rightSpectrum)
        rightAnalyzer.computeSpectrum(rightSpectrum)

        for (k in 0 until bins) {
            assertEquals(spectrum[k], rightSpectrum[bins + k])
        }
    }

    @Test
    fun triggersReadErrorTeardownWhenActiveRecorderReturnsNegativeStatus() {
        val frames = mutableListOf<String>()
        var readErrors = 0
        var calls = 0

        OutlineAudioCaptureService.runCaptureLoop(
            isSessionActive = { true },
            readChunk = { pcm ->
                when (calls++) {
                    0 -> {
                        for (i in 0 until 256) {
                            pcm[i * 2] = (0.4 * sin(2.0 * PI * 440.0 * i / 48_000)).toFloat()
                        }
                        512
                    }
                    else -> -6 // AudioRecord.ERROR_DEAD_OBJECT
                }
            },
            onSpectrum = frames::add,
            onReadError = { readErrors++ },
        )

        assertEquals(1, frames.size)
        assertEquals(
            OutlineAudioAnalyzer.STEREO_SPECTRUM_BYTES,
            java.util.Base64.getDecoder().decode(frames.single()).size,
        )
        assertEquals(1, readErrors)
    }

    @Test
    fun ignoresNegativeReadAfterIntentionalSessionStop() {
        var active = true
        var readErrors = 0

        OutlineAudioCaptureService.runCaptureLoop(
            isSessionActive = { active },
            readChunk = {
                active = false
                -3 // Unblocked after releaseActiveCapture() stopped the recorder
            },
            onSpectrum = {},
            onReadError = { readErrors++ },
        )

        assertEquals(0, readErrors)
    }
}
