package io.github.yet_another_ai.deskfleet.nativedesktop

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.getcapacitor.JSObject

/** All entry points and SpeechRecognizer callbacks run on the activity's main thread. */
internal class SpeechInput(
    private val context: Context,
    private val emit: (JSObject) -> Unit,
) {
    private class Session(val id: String, val locale: String) {
        var recognizer: SpeechRecognizer? = null
        var stopped = false
        var completionDeadline: Runnable? = null
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var active: Session? = null
    private var disposed = false

    fun isSupported(): Boolean = !disposed && SpeechRecognizer.isRecognitionAvailable(context)

    fun prepare(sessionId: String, locale: String) {
        if (disposed) return
        active?.let(::finish)
        active = Session(sessionId, locale)
    }

    fun start(sessionId: String) {
        val session = active?.takeIf { it.id == sessionId } ?: return
        if (!isSupported()) {
            fail(sessionId, "unavailable")
            return
        }
        try {
            val recognizer = SpeechRecognizer.createSpeechRecognizer(context)
            session.recognizer = recognizer
            recognizer.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {
                    event(session, "started")
                }

                override fun onBeginningOfSpeech() = Unit

                override fun onRmsChanged(rmsdB: Float) {
                    if (rmsdB.isFinite() && !session.stopped) {
                        event(session, "level") { put("level", ((rmsdB + 2f) / 12f).coerceIn(0f, 1f).toDouble()) }
                    }
                }

                override fun onBufferReceived(buffer: ByteArray?) = Unit

                override fun onEndOfSpeech() {
                    event(session, "level") { put("level", 0) }
                }

                override fun onError(error: Int) {
                    if (active !== session) return
                    val code = when (error) {
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "permission-denied"
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no-speech"
                        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network"
                        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE,
                        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "unavailable"
                        else -> "failed"
                    }
                    fail(session.id, code)
                }

                override fun onResults(results: Bundle?) {
                    if (active !== session) return
                    val text = transcript(results)
                    if (text.isBlank()) fail(session.id, "no-speech")
                    else {
                        event(session, "result") { put("text", text); put("final", true) }
                        finish(session)
                    }
                }

                override fun onPartialResults(partialResults: Bundle?) {
                    val text = transcript(partialResults)
                    if (text.isNotBlank()) event(session, "result") { put("text", text); put("final", false) }
                }

                override fun onEvent(eventType: Int, params: Bundle?) = Unit
            })
            recognizer.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, session.locale)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            })
        } catch (_: SecurityException) {
            fail(session.id, "permission-denied")
        } catch (_: Exception) {
            fail(session.id, "failed")
        }
    }

    fun stop(sessionId: String) {
        val session = active?.takeIf { it.id == sessionId } ?: return
        if (session.stopped) return
        session.stopped = true
        val recognizer = session.recognizer
        if (recognizer == null) finish(session)
        else {
            event(session, "level") { put("level", 0) }
            try {
                // Some recognition services never deliver a final callback after stop.
                val deadline = Runnable {
                    if (active === session) fail(session.id, "failed")
                }
                session.completionDeadline = deadline
                mainHandler.postDelayed(deadline, 10_000)
                // onResults delivers the final transcript before finish emits ended.
                recognizer.stopListening()
            } catch (_: Exception) {
                fail(session.id, "failed")
            }
        }
    }

    fun cancel(sessionId: String) {
        active?.takeIf { it.id == sessionId }?.let(::finish)
    }

    fun fail(sessionId: String, code: String) {
        val session = active?.takeIf { it.id == sessionId } ?: return
        event(session, "error") { put("code", code) }
        finish(session)
    }

    fun dispose() {
        disposed = true
        active?.let(::finish)
    }

    fun pause() {
        // A microphone permission dialog may pause the activity before recognition starts.
        active?.takeIf { it.recognizer != null }?.let(::finish)
    }

    private fun finish(session: Session) {
        if (active !== session) return
        active = null
        session.completionDeadline?.let(mainHandler::removeCallbacks)
        session.completionDeadline = null
        session.recognizer?.apply {
            cancel()
            destroy()
        }
        session.recognizer = null
        emit(JSObject().put("sessionId", session.id).put("type", "ended"))
    }

    private fun event(session: Session, type: String, fields: JSObject.() -> Unit = {}) {
        if (active === session) emit(JSObject().put("sessionId", session.id).put("type", type).apply(fields))
    }

    private fun transcript(results: Bundle?): String =
        results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
}
