import { captureDisplays, supportedVideoCodecs } from "@deskfleet/native"
import type { DesktopCapabilities, VideoCodec } from "./control-protocol.ts"

export async function desktopCapabilities(
  native = { captureDisplays, supportedVideoCodecs },
): Promise<DesktopCapabilities> {
  const displays = await native.captureDisplays()
  return {
    displays: await Promise.all(displays.map(async display => ({
      ...display,
      codecs: (await native.supportedVideoCodecs(display.id))
        .filter((codec): codec is VideoCodec => codec === "h264" || codec === "h265" || codec === "av1"),
    }))),
    audio: process.platform === "darwin",
  }
}
