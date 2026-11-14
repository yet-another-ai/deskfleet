import assert from "node:assert/strict"
import test from "node:test"
import { desktopCapabilities, supportsDesktop } from "./desktop-capabilities.ts"

test("desktop support comes from the native runtime and a failed probe leaves headless access available", async t => {
  assert.equal(await supportsDesktop(async () => true), true)
  assert.equal(await supportsDesktop(async () => false), false)
  const diagnostics = t.mock.method(console, "error", () => {})
  assert.equal(await supportsDesktop(async () => { throw new Error("No session bus") }), false)
  assert.equal(diagnostics.mock.callCount(), 1)
})

test("desktop capabilities keep codecs attached to each display's GPU", async () => {
  const probed: number[] = []
  const displays = [
    { id: 4, width: 1920, height: 1080, refreshRateHz: 60 },
    { id: 7, width: 2560, height: 1440, refreshRateHz: 60 },
    { id: 9, width: 1280, height: 720, refreshRateHz: 60 },
  ]
  const result = await desktopCapabilities({
    secureAttentionSupported: async () => false,
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

test("display names and user numbers do not replace capture IDs during codec discovery", async () => {
  const displays = [
    { id: 65537, name: "Dell U2723QE (DISPLAY1)", displayNumber: 1, width: 3840, height: 2160, refreshRateHz: 60 },
    { id: 4, name: "DP-2", displayNumber: 2, width: 1920, height: 1080, refreshRateHz: 60 },
  ]
  const probed: number[] = []
  const result = await desktopCapabilities({
    captureDisplays: async () => displays,
    supportedVideoCodecs: async id => { probed.push(id); return ["h264"] },
    secureAttentionSupported: async () => false,
  })
  assert.deepEqual(probed, [65537, 4])
  assert.deepEqual(result.displays, displays.map(display => ({ ...display, codecs: ["h264"] })))
})

test("a failed display codec probe preserves usable neighboring displays", async t => {
  const failure = new Error("open display adapter failed")
  const diagnostics = t.mock.method(console, "error", () => {})
  const probed: number[] = []
  const displays = [
    { id: 4, width: 1920, height: 1080, refreshRateHz: 60 },
    { id: 7, width: 2560, height: 1440, refreshRateHz: 60 },
    { id: 9, width: 1280, height: 720, refreshRateHz: 60 },
  ]
  const result = await desktopCapabilities({
    secureAttentionSupported: async () => false,
    captureDisplays: async () => displays,
    supportedVideoCodecs: async id => {
      probed.push(id)
      if (id === 7) throw failure
      return id === 4 ? ["h264", "h265", "av1"] : ["h264"]
    },
  })
  assert.deepEqual(probed, [4, 7, 9])
  assert.deepEqual(result.displays, [
    { ...displays[0], codecs: ["h264", "h265", "av1"] },
    { ...displays[1], codecs: [] },
    { ...displays[2], codecs: ["h264"] },
  ])
  assert.equal(diagnostics.mock.callCount(), 1)
  assert.match(diagnostics.mock.calls[0]!.arguments[0], /display 7/u)
  assert.equal(diagnostics.mock.calls[0]!.arguments[1], failure)
})

test("display enumeration failures reject the capability request", async () => {
  const failure = new Error("display enumeration failed")
  await assert.rejects(desktopCapabilities({
    secureAttentionSupported: async () => false,
    captureDisplays: async () => { throw failure },
    supportedVideoCodecs: async () => { assert.fail("No display should be probed after enumeration fails") },
  }), error => error === failure)
})

for (const supported of [true, false]) {
  test(`secure attention capability follows the native service and policy probe: ${supported}`, async () => {
    const result = await desktopCapabilities({
      captureDisplays: async () => [],
      supportedVideoCodecs: async () => [],
      secureAttentionSupported: async () => supported,
    })
    assert.equal(result.secureAttention, supported)
  })
}

test("secure attention probe failure hides the action without hiding usable desktop capture", async t => {
  const diagnostics = t.mock.method(console, "error", () => {})
  const result = await desktopCapabilities({
    captureDisplays: async () => [{ id: 1, width: 1920, height: 1080, refreshRateHz: 60 }],
    supportedVideoCodecs: async () => ["h264"],
    secureAttentionSupported: async () => { throw new Error("Cannot read Windows policy") },
  })
  assert.equal(result.secureAttention, false)
  assert.deepEqual(result.displays[0]?.codecs, ["h264"])
  assert.equal(diagnostics.mock.callCount(), 1)
})
