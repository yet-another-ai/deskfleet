package io.github.yet_another_ai.deskfleet.nativedesktop

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.IntentCompat
import java.util.Base64
import kotlin.math.abs

class OutlineAudioCaptureService : Service() {
    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile private var captureThread: Thread? = null
    private var mediaProjection: MediaProjection? = null
    private var audioRecord: AudioRecord? = null

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() = stopCaptureSession()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundNotification()

        val resultData = intent?.let { IntentCompat.getParcelableExtra(it, EXTRA_RESULT_DATA, Intent::class.java) }
        val manager = getSystemService(MediaProjectionManager::class.java)
        if (resultData == null || manager == null) {
            DeskFleetBridge.completeOutlineAudioStart(false, "Missing screen capture authorization")
            stopCaptureSession()
            return START_NOT_STICKY
        }

        runCatching {
            releaseActiveCapture()
            // DeskFleetBridge only starts this service after the consent activity returned RESULT_OK.
            val projection = manager.getMediaProjection(Activity.RESULT_OK, resultData)
                ?: error("Could not acquire MediaProjection")
            projection.registerCallback(projectionCallback, mainHandler)
            mediaProjection = projection

            val playbackConfig = AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()

            val minBytes = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_FLOAT)
            val record = AudioRecord.Builder()
                .setAudioPlaybackCaptureConfig(playbackConfig)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                        .build(),
                )
                .setBufferSizeInBytes(maxOf(minBytes, CHUNK_FRAMES * 2 * Float.SIZE_BYTES * 4))
                .build()

            if (record.state != AudioRecord.STATE_INITIALIZED) {
                record.release()
                error("AudioRecord failed to initialize")
            }
            record.startRecording()
            audioRecord = record
            isActive = true
            startCaptureLoop(record)
            DeskFleetBridge.completeOutlineAudioStart(true, null)
        }.onFailure { err ->
            DeskFleetBridge.completeOutlineAudioStart(false, err.message)
            stopCaptureSession()
        }

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopCaptureSession(callStopSelf = false)
        super.onDestroy()
    }

    private fun startCaptureLoop(record: AudioRecord) {
        captureThread = Thread({
            runCaptureLoop(
                isSessionActive = { isActive },
                readChunk = { pcm -> record.read(pcm, 0, pcm.size, AudioRecord.READ_BLOCKING) },
                onSpectrum = { encoded -> DeskFleetBridge.onOutlineAudioSpectrum(SAMPLE_RATE, encoded) },
                onReadError = {
                    mainHandler.post {
                        if (audioRecord === record) {
                            stopCaptureSession()
                        }
                    }
                },
            )
        }, "deskfleet-outline-audio").apply {
            isDaemon = true
            start()
        }
    }

    private fun releaseActiveCapture(): Boolean {
        val wasActive = isActive
        isActive = false

        val record = audioRecord
        audioRecord = null
        if (record != null && record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
            record.stop()
        }

        captureThread?.let { thread ->
            captureThread = null
            thread.interrupt()
            try {
                thread.join(200)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        record?.release()

        mediaProjection?.let { projection ->
            mediaProjection = null
            projection.unregisterCallback(projectionCallback)
            projection.stop()
        }
        return wasActive
    }

    private fun stopCaptureSession(callStopSelf: Boolean = true) {
        val wasActive = releaseActiveCapture()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        if (wasActive) DeskFleetBridge.onOutlineAudioStopped()
        if (callStopSelf) stopSelf()
    }

    private fun startForegroundNotification() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager != null && manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Audio-reactive outline", NotificationManager.IMPORTANCE_LOW).apply {
                    setShowBadge(false)
                    enableVibration(false)
                    setSound(null, null)
                },
            )
        }
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_media_play)
            .setContentTitle("DeskFleet")
            .setContentText("Capturing device audio for outline animation")
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    }

    companion object {
        private const val CHANNEL_ID = "deskfleet_outline_audio"
        private const val NOTIFICATION_ID = 47701
        private const val SAMPLE_RATE = 48_000
        private const val CHUNK_FRAMES = 1024

        const val EXTRA_RESULT_DATA = "result_data"

        @Volatile var isActive: Boolean = false
            private set

        fun createStartIntent(context: Context, data: Intent): Intent =
            Intent(context, OutlineAudioCaptureService::class.java).putExtra(EXTRA_RESULT_DATA, data)

        fun stop(context: Context) {
            if (isActive) {
                context.stopService(Intent(context, OutlineAudioCaptureService::class.java))
            }
        }

        internal fun runCaptureLoop(
            isSessionActive: () -> Boolean,
            readChunk: (FloatArray) -> Int,
            onSpectrum: (String) -> Unit,
            onReadError: () -> Unit,
        ) {
            val encoder = Base64.getEncoder()
            val analyzer = OutlineAudioAnalyzer()
            val pcm = FloatArray(CHUNK_FRAMES * 2)
            val spectrum = ByteArray(OutlineAudioAnalyzer.STEREO_SPECTRUM_BYTES)
            var wasSilent = true

            while (isSessionActive() && !Thread.currentThread().isInterrupted) {
                val readFloats = readChunk(pcm)
                if (readFloats < 0) {
                    if (isSessionActive() && !Thread.currentThread().isInterrupted) {
                        onReadError()
                    }
                    break
                }
                if (readFloats < 2) continue

                var peak = 0f
                for (i in 0 until readFloats) {
                    val amplitude = abs(pcm[i])
                    if (amplitude > peak) peak = amplitude
                }
                if (peak < 1e-5f && wasSilent) continue

                analyzer.pushInterleavedStereo(pcm, readFloats / 2)
                val hasSignal = analyzer.computeSpectrum(spectrum)
                wasSilent = !hasSignal
                onSpectrum(encoder.encodeToString(spectrum))
            }
        }
    }
}
