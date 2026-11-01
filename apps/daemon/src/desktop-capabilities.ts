import { captureDisplays, desktopSupported, secureAttentionSupported, supportedVideoCodecs } from "@deskfleet/native"
import type { DesktopCapabilities, VideoCodec } from "./control-protocol.ts"

/** Graphical capability discovery must not prevent headless machine access. */
export async function supportsDesktop(probe: () => Promise<boolean> = desktopSupported): Promise<boolean> {
  try { return await probe() }
  catch (error) { console.error("Desktop capability probe failed", error); return false }
}

export async function desktopCapabilities(
  native = { captureDisplays, supportedVideoCodecs, secureAttentionSupported },
): Promise<DesktopCapabilities> {
  const displays = await native.captureDisplays()
  const secureAttention = native.secureAttentionSupported().catch(error => {
    console.error("Secure attention capability probe failed", error)
    return false
  })
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
    secureAttention: await secureAttention,
  }
}
