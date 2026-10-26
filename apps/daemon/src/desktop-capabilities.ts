import { captureDisplays, desktopSupported, supportedVideoCodecs } from "@deskfleet/native"
import type { DesktopCapabilities, VideoCodec } from "./control-protocol.ts"

/** Graphical capability discovery must not prevent headless machine access. */
export async function supportsDesktop(probe: () => Promise<boolean> = desktopSupported): Promise<boolean> {
  try { return await probe() }
  catch (error) { console.error("Desktop capability probe failed", error); return false }
}

export async function desktopCapabilities(
  native = { captureDisplays, supportedVideoCodecs },
): Promise<DesktopCapabilities> {
  const displays = await native.captureDisplays()
  return {
    displays: await Promise.all(displays.map(async display => {
      let codecs: string[]
      try {
        codecs = await native.supportedVideoCodecs(display.id)
      } catch (error) {
        console.error(`Desktop codec probe failed for display ${display.id}`, error)
        codecs = []
      }
      return {
        ...display,
        codecs: codecs.filter((codec): codec is VideoCodec => codec === "h264" || codec === "h265" || codec === "av1"),
      }
    })),
    audio: process.platform === "darwin",
  }
}
