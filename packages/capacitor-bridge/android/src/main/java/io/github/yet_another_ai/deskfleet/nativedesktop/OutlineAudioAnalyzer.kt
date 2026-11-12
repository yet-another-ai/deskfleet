package io.github.yet_another_ai.deskfleet.nativedesktop

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.min
import kotlin.math.sin

internal class OutlineAudioAnalyzer {
    private val ringLeft = FloatArray(FFT_SIZE)
    private val ringRight = FloatArray(FFT_SIZE)
    private var ringCursor = 0

    private val real = FloatArray(FFT_SIZE)
    private val imag = FloatArray(FFT_SIZE)
    private val smoothedLeft = FloatArray(SPECTRUM_BINS)
    private val smoothedRight = FloatArray(SPECTRUM_BINS)

    fun pushInterleavedStereo(samples: FloatArray, frameCount: Int) {
        val frames = min(frameCount, samples.size / 2)
        var cursor = ringCursor
        var offset = 0
        for (i in 0 until frames) {
            ringLeft[cursor] = samples[offset]
            ringRight[cursor] = samples[offset + 1]
            offset += 2
            cursor = (cursor + 1) and RING_MASK
        }
        ringCursor = cursor
    }

    /** Writes [left(224), right(224)] dB bytes in [-80, -10] dB and returns true if any bin > 0. */
    fun computeSpectrum(outBytes: ByteArray): Boolean {
        for (n in 0 until FFT_SIZE) {
            val idx = (ringCursor + n) and RING_MASK
            val w = WINDOW[n]
            val target = BIT_REV[n]
            real[target] = ringLeft[idx] * w
            imag[target] = ringRight[idx] * w
        }

        fftInPlace(real, imag)

        val invTwoN = 0.5f / FFT_SIZE
        var nonZero = false
        for (k in 1 until SPECTRUM_BINS) {
            val m = FFT_SIZE - k
            val lMag = hypot((real[k] + real[m]) * invTwoN, (imag[k] - imag[m]) * invTwoN)
            val rMag = hypot((imag[k] + imag[m]) * invTwoN, (real[m] - real[k]) * invTwoN)
            val sL = SMOOTHING * smoothedLeft[k] + (1f - SMOOTHING) * lMag
            val sR = SMOOTHING * smoothedRight[k] + (1f - SMOOTHING) * rMag
            smoothedLeft[k] = sL
            smoothedRight[k] = sR
            val bL = toDbByte(sL)
            val bR = toDbByte(sR)
            outBytes[k] = bL
            outBytes[SPECTRUM_BINS + k] = bR
            if (bL.toInt() != 0 || bR.toInt() != 0) nonZero = true
        }
        return nonZero
    }

    companion object {
        const val FFT_SIZE = 4096
        const val SPECTRUM_BINS = 224
        const val STEREO_SPECTRUM_BYTES = SPECTRUM_BINS * 2
        private const val LOG2_FFT = 12
        private const val BIN_COUNT = FFT_SIZE / 2
        private const val RING_MASK = FFT_SIZE - 1
        private const val SMOOTHING = 0.2f
        private const val MIN_LINEAR = 1e-4f // -80 dB

        private val WINDOW = FloatArray(FFT_SIZE) { n ->
            val phase = 2.0 * PI * n / FFT_SIZE
            (0.42 - 0.5 * cos(phase) + 0.08 * cos(2.0 * phase)).toFloat()
        }
        private val BIT_REV = IntArray(FFT_SIZE) { i -> Integer.reverse(i) ushr (32 - LOG2_FFT) }
        private val TWIDDLE_COS = FloatArray(BIN_COUNT) { k -> cos(-2.0 * PI * k / FFT_SIZE).toFloat() }
        private val TWIDDLE_SIN = FloatArray(BIN_COUNT) { k -> sin(-2.0 * PI * k / FFT_SIZE).toFloat() }

        private fun toDbByte(magnitude: Float): Byte {
            if (magnitude <= MIN_LINEAR) return 0
            val scaled = ((20f * log10(magnitude) + 80f) * (255f / 70f)).toInt()
            return scaled.coerceIn(0, 255).toByte()
        }

        private fun fftInPlace(re: FloatArray, im: FloatArray) {
            var halfSize = 1
            var tableStep = BIN_COUNT
            while (halfSize < FFT_SIZE) {
                val step = halfSize shl 1
                var i = 0
                while (i < FFT_SIZE) {
                    var twiddleIdx = 0
                    for (j in i until (i + halfSize)) {
                        val l = j + halfSize
                        val wr = TWIDDLE_COS[twiddleIdx]
                        val wi = TWIDDLE_SIN[twiddleIdx]
                        val tr = wr * re[l] - wi * im[l]
                        val ti = wr * im[l] + wi * re[l]
                        re[l] = re[j] - tr
                        im[l] = im[j] - ti
                        re[j] += tr
                        im[j] += ti
                        twiddleIdx += tableStep
                    }
                    i += step
                }
                halfSize = step
                tableStep = tableStep shr 1
            }
        }
    }
}
