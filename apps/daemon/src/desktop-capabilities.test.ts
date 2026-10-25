import assert from "node:assert/strict"
import test from "node:test"
import { desktopCapabilities } from "./desktop-capabilities.ts"

test("desktop capabilities keep codecs attached to each display's GPU", async () => {
  const probed: number[] = []
  const displays = [
    { id: 4, width: 1920, height: 1080, refreshRateHz: 60 },
    { id: 7, width: 2560, height: 1440, refreshRateHz: 60 },
    { id: 9, width: 1280, height: 720, refreshRateHz: 60 },
  ]
  const result = await desktopCapabilities({
    captureDisplays: async () => displays,
    supportedVideoCodecs: async id => {
      probed.push(id)
      return id === 4 ? ["h264", "h265", "av1"] : id === 7 ? ["h264"] : []
    },
  })
  assert.deepEqual(probed, [4, 7, 9])
  assert.deepEqual(result.displays, [
    { ...displays[0], codecs: ["h264", "h265", "av1"] },
    { ...displays[1], codecs: ["h264"] },
    { ...displays[2], codecs: [] },
  ])
})
