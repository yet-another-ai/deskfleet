package ai.yetanother.deskfleet.ui.theme

import androidx.compose.runtime.*
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.min

data class SpringParameters(
    val duration: Double = 0.5,
    val bounce: Double = 0.16,
) {
    val omega: Double get() = (2.0 * PI) / duration.coerceAtLeast(0.05)
    val zeta: Double get() = (1.0 - bounce).coerceIn(0.05, 1.5)
    val maxSubStepSeconds: Double get() = min(1.0 / 120.0, 0.1 / omega)
}

/**
 * Exact Kotlin Multiplatform port of `packages/components/src/services/spring.ts` (`SpringController`):
 * - Semi-implicit Euler integration with sub-stepping (`min(1/120, 0.1/omega)`)
 * - Gesture drag tracking with 80ms pause velocity decay (`dragTo` / `endDrag`)
 * - Supports both spring-to-target and inertia projection.
 */
@Stable
class SpringController(
    initialValue: Float = 0f,
    var params: SpringParameters = SpringParameters(),
) {
    var value by mutableFloatStateOf(initialValue)
        private set
    var target by mutableFloatStateOf(initialValue)
        private set
    var velocity by mutableFloatStateOf(0f)
        private set
    var isDragging by mutableStateOf(false)
        private set

    private var lastDragTimeMs: Long = 0L

    val isSettled: Boolean
        get() = !isDragging && abs(target - value) < 0.0008f && abs(velocity) < 0.005f

    fun snapTo(newValue: Float) {
        isDragging = false
        value = newValue
        target = newValue
        velocity = 0f
    }

    fun animateTo(newTarget: Float, initialVelocity: Float? = null) {
        isDragging = false
        target = newTarget
        if (initialVelocity != null) {
            velocity = initialVelocity
        }
    }

    fun dragTo(dragValue: Float, nowMillis: Long) {
        if (!isDragging) {
            isDragging = true
            velocity = 0f
        } else {
            val dtSec = (nowMillis - lastDragTimeMs) / 1000.0
            if (dtSec in 0.001..0.080) {
                val instantVel = ((dragValue - value) / dtSec).toFloat()
                velocity = velocity * 0.35f + instantVel * 0.65f
            } else if (dtSec > 0.080) {
                velocity = 0f
            }
        }
        value = dragValue
        target = dragValue
        lastDragTimeMs = nowMillis
    }

    fun endDrag(releaseTarget: Float, nowMillis: Long) {
        if (nowMillis - lastDragTimeMs > 80L) {
            velocity = 0f
        }
        isDragging = false
        target = releaseTarget
    }

    /** Advances simulation by `deltaSeconds` using semi-implicit Euler sub-steps. */
    fun step(deltaSeconds: Double) {
        if (isDragging || isSettled) return
        var remaining = deltaSeconds.coerceIn(0.0, 0.1)
        val omega = params.omega
        val zeta = params.zeta
        val maxStep = params.maxSubStepSeconds
        var x = value.toDouble()
        var v = velocity.toDouble()
        val tgt = target.toDouble()

        while (remaining > 1e-6) {
            val dt = min(remaining, maxStep)
            val displacement = x - tgt
            val accel = -(omega * omega) * displacement - (2.0 * zeta * omega) * v
            v += accel * dt
            x += v * dt
            remaining -= dt
        }

        if (abs(tgt - x) < 0.0008 && abs(v) < 0.005) {
            value = target
            velocity = 0f
        } else {
            value = x.toFloat()
            velocity = v.toFloat()
        }
    }
}

@Composable
fun rememberSpringController(
    initialValue: Float = 0f,
    duration: Double = 0.5,
    bounce: Double = 0.16,
): SpringController {
    val controller = remember { SpringController(initialValue, SpringParameters(duration, bounce)) }
    LaunchedEffect(duration, bounce) {
        controller.params = SpringParameters(duration, bounce)
    }
    LaunchedEffect(controller.target, controller.isDragging, controller.isSettled) {
        if (controller.isDragging || controller.isSettled) return@LaunchedEffect
        var lastFrameNanos = withFrameNanos { it }
        while (!controller.isDragging && !controller.isSettled) {
            val now = withFrameNanos { it }
            val dt = (now - lastFrameNanos) / 1_000_000_000.0
            lastFrameNanos = now
            controller.step(dt)
        }
    }
    return controller
}

@Composable
fun animateSpringFloat(
    targetValue: Float,
    duration: Double = 0.35,
    bounce: Double = 0.14,
): State<Float> {
    val controller = rememberSpringController(targetValue, duration, bounce)
    LaunchedEffect(targetValue) {
        if (controller.target != targetValue) {
            controller.animateTo(targetValue)
        }
    }
    return remember(controller) { derivedStateOf { controller.value } }
}
