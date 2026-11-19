package io.github.yet_another_ai.deskfleet.nativedesktop

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.lang.ref.WeakReference

class RemoteDesktopActivity : AppCompatActivity(), SurfaceHolder.Callback {

    private var dragging = false
    private var closeSent = false
    private val clipboardSync = RemoteDesktopClipboard()
    private var clipboardManager: ClipboardManager? = null
    private val clipListener = ClipboardManager.OnPrimaryClipChangedListener {
        syncLocalClipboardToRemote()
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DeskFleetBridge.activeActivity = WeakReference(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemBars()

        val surfaceView = SurfaceView(this).apply {
            holder.addCallback(this@RemoteDesktopActivity)
        }
        val detector = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent) = true

            override fun onSingleTapUp(e: MotionEvent): Boolean {
                DeskFleetBridge.nativeTouch(3, e.x.toDouble(), e.y.toDouble(), 0.0, 0.0)
                return true
            }

            override fun onLongPress(e: MotionEvent) {
                DeskFleetBridge.nativeTouch(4, e.x.toDouble(), e.y.toDouble(), 0.0, 0.0)
            }

            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
                val x = e2.x.toDouble()
                val y = e2.y.toDouble()
                if (e2.pointerCount >= 2) {
                    if (dragging) {
                        dragging = false
                        DeskFleetBridge.nativeTouch(2, x, y, 0.0, 0.0)
                    }
                    DeskFleetBridge.nativeTouch(5, x, y, dx.toDouble(), dy.toDouble())
                } else {
                    if (!dragging && e1 != null) {
                        dragging = true
                        DeskFleetBridge.nativeTouch(1, e1.x.toDouble(), e1.y.toDouble(), 0.0, 0.0)
                    }
                    DeskFleetBridge.nativeTouch(0, x, y, 0.0, 0.0)
                }
                return true
            }
        })

        surfaceView.setOnTouchListener { _, event ->
            detector.onTouchEvent(event)
            val action = event.actionMasked
            if ((action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) && dragging) {
                dragging = false
                DeskFleetBridge.nativeTouch(2, event.x.toDouble(), event.y.toDouble(), 0.0, 0.0)
            }
            true
        }

        val m = dp(16f)
        val closeButton = TextView(this).apply {
            text = "✕"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setPadding(dp(12f), dp(6f), dp(12f), dp(6f))
            gravity = Gravity.CENTER
            contentDescription = "Disconnect"
            background = GradientDrawable().apply {
                cornerRadius = dp(18f).toFloat()
                setColor(Color.argb(140, 20, 20, 24))
                setStroke(dp(1f), Color.argb(90, 255, 255, 255))
            }
            setOnClickListener { requestCloseAndFinish() }
        }
        val clipboardButton = TextView(this).apply {
            text = "📋"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setPadding(dp(12f), dp(6f), dp(12f), dp(6f))
            gravity = Gravity.CENTER
            contentDescription = "Clipboard sharing"
            background = GradientDrawable().apply {
                cornerRadius = dp(18f).toFloat()
                setColor(Color.argb(140, 20, 20, 24))
                setStroke(dp(1f), Color.argb(90, 255, 255, 255))
            }
            setOnClickListener { syncLocalClipboardToRemote() }
        }

        clipboardManager = getSystemService(ClipboardManager::class.java)?.also {
            it.addPrimaryClipChangedListener(clipListener)
        }

        setContentView(FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(surfaceView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(closeButton, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
                setMargins(m, m, m, m)
            })
            addView(clipboardButton, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
                setMargins(m + dp(46f), m, m, m)
            })
        })

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = requestCloseAndFinish()
        })
    }

    private fun dp(value: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics).toInt()

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            hideSystemBars()
            window.decorView.post { syncLocalClipboardToRemote() }
        } else {
            dragging = false
            DeskFleetBridge.nativeTouch(6, 0.0, 0.0, 0.0, 0.0)
        }
    }

    internal fun applyRemoteClipboard(payload: String) {
        val text = clipboardSync.acceptIncomingEvent(payload) ?: return
        runOnUiThread {
            runCatching {
                clipboardManager?.setPrimaryClip(ClipData.newPlainText("DeskFleet", text))
            }
        }
    }

    private fun syncLocalClipboardToRemote() {
        runCatching {
            val clip = clipboardManager?.primaryClip ?: return
            if (clip.itemCount <= 0) return
            val text = clip.getItemAt(0).text ?: return
            val command = clipboardSync.takeOutgoingCommand(text) ?: return
            DeskFleetBridge.nativeSendCommand(command)
        }
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun requestCloseAndFinish() {
        if (!closeSent) {
            closeSent = true
            DeskFleetBridge.nativeTouch(7, 0.0, 0.0, 0.0, 0.0)
        }
        finish()
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        val frame = holder.surfaceFrame
        DeskFleetBridge.nativeSurfaceCreated(
            holder.surface,
            frame.width().coerceAtLeast(1),
            frame.height().coerceAtLeast(1),
        )
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        DeskFleetBridge.nativeSurfaceChanged(width, height)
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        DeskFleetBridge.nativeSurfaceDestroyed()
    }

    override fun onDestroy() {
        runCatching { clipboardManager?.removePrimaryClipChangedListener(clipListener) }
        val active = DeskFleetBridge.activeActivity?.get() === this
        if (active) DeskFleetBridge.activeActivity = null
        if (active && isFinishing && !closeSent) {
            closeSent = true
            DeskFleetBridge.nativeTouch(7, 0.0, 0.0, 0.0, 0.0)
        }
        super.onDestroy()
    }
}
