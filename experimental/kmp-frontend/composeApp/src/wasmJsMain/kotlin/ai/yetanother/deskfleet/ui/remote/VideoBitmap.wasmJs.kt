package ai.yetanother.deskfleet.ui.remote

import ai.yetanother.deskfleet.transport.DecodedVideoFrame
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import org.jetbrains.skia.Bitmap
import org.jetbrains.skia.ColorAlphaType
import org.jetbrains.skia.ColorType
import org.jetbrains.skia.Image
import org.jetbrains.skia.ImageInfo

actual fun bgraFrameToImageBitmap(frame: DecodedVideoFrame): ImageBitmap {
    val info = ImageInfo(frame.width, frame.height, ColorType.BGRA_8888, ColorAlphaType.OPAQUE)
    val bmp = Bitmap()
    bmp.allocPixels(info)
    bmp.installPixels(info, frame.bgraBytes, frame.width * 4)
    return Image.makeFromBitmap(bmp).toComposeImageBitmap()
}
