package ai.yetanother.deskfleet.ui.remote

import ai.yetanother.deskfleet.transport.DecodedVideoFrame
import androidx.compose.ui.graphics.ImageBitmap

expect fun bgraFrameToImageBitmap(frame: DecodedVideoFrame): ImageBitmap
