package ai.yetanother.deskfleet.ui.remote

import ai.yetanother.deskfleet.transport.DecodedVideoFrame
import android.graphics.Bitmap
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap

actual fun bgraFrameToImageBitmap(frame: DecodedVideoFrame): ImageBitmap {
    val w = frame.width
    val h = frame.height
    val pixels = IntArray(w * h)
    val src = frame.bgraBytes
    var p = 0
    for (i in pixels.indices) {
        val b = src[p].toInt() and 0xFF
        val g = src[p + 1].toInt() and 0xFF
        val r = src[p + 2].toInt() and 0xFF
        val a = src[p + 3].toInt() and 0xFF
        pixels[i] = (a shl 24) or (r shl 16) or (g shl 8) or b
        p += 4
    }
    return Bitmap.createBitmap(pixels, w, h, Bitmap.Config.ARGB_8888).asImageBitmap()
}
