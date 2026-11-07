package io.github.yet_another_ai.deskfleet.nativedesktop

import android.annotation.SuppressLint
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

    @SuppressLint("ClickableViewAccessibility")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        NativeDesktopPlugin.activeActivity = WeakReference(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemBars()

        val surfaceView = SurfaceView(this).apply {
            holder.addCallback(this@RemoteDesktopActivity)
        }
        val detector = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent) = true

            override fun onSingleTapUp(e: MotionEvent): Boolean {
                NativeDesktopPlugin.nativeTouch(3, e.x.toDouble(), e.y.toDouble(), 0.0, 0.0)
                return true
            }

            override fun onLongPress(e: MotionEvent) {
                NativeDesktopPlugin.nativeTouch(4, e.x.toDouble(), e.y.toDouble(), 0.0, 0.0)
            }

            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
                val x = e2.x.toDouble()
                val y = e2.y.toDouble()
                if (e2.pointerCount >= 2) {
                    if (dragging) {
                        dragging = false
                        NativeDesktopPlugin.nativeTouch(2, x, y, 0.0, 0.0)
                    }
                    NativeDesktopPlugin.nativeTouch(5, x, y, dx.toDouble(), dy.toDouble())
                } else {
                    if (!dragging && e1 != null) {
                        dragging = true
                        NativeDesktopPlugin.nativeTouch(1, e1.x.toDouble(), e1.y.toDouble(), 0.0, 0.0)
                    }
                    NativeDesktopPlugin.nativeTouch(0, x, y, 0.0, 0.0)
                }
                return true
            }
        })

        surfaceView.setOnTouchListener { _, event ->
            detector.onTouchEvent(event)
            val action = event.actionMasked
            if ((action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) && dragging) {
                dragging = false
                NativeDesktopPlugin.nativeTouch(2, event.x.toDouble(), event.y.toDouble(), 0.0, 0.0)
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

        setContentView(FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(surfaceView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(closeButton, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
                setMargins(m, m, m, m)
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
        if (hasFocus) hideSystemBars() else {
            dragging = false
            NativeDesktopPlugin.nativeTouch(6, 0.0, 0.0, 0.0, 0.0)
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
            NativeDesktopPlugin.nativeTouch(7, 0.0, 0.0, 0.0, 0.0)
        }
        finish()
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        val frame = holder.surfaceFrame
        NativeDesktopPlugin.nativeSurfaceCreated(
            holder.surface,
            frame.width().coerceAtLeast(1),
            frame.height().coerceAtLeast(1),
        )
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        NativeDesktopPlugin.nativeSurfaceChanged(width, height)
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        NativeDesktopPlugin.nativeSurfaceDestroyed()
    }

    override fun onDestroy() {
        val active = NativeDesktopPlugin.activeActivity?.get() === this
        if (active) NativeDesktopPlugin.activeActivity = null
        if (active && isFinishing && !closeSent) {
            closeSent = true
            NativeDesktopPlugin.nativeTouch(7, 0.0, 0.0, 0.0, 0.0)
        }
        super.onDestroy()
    }
}
