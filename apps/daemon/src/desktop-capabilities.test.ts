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
    captureDisplays: async () => { throw failure },
    supportedVideoCodecs: async () => { assert.fail("No display should be probed after enumeration fails") },
  }), error => error === failure)
})
