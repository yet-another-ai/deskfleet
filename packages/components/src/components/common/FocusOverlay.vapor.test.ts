import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { compileScript, parse } from "@vue/compiler-sfc"
import { build } from "esbuild"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"

interface Preview { title: string; source: { entryId: string } }
interface OverlayHarness {
  state: { content?: Preview; leaves: number; presentAtLeave: boolean }
  errors: Error[]
  flush(): Promise<void>
  unmount(): void
}
let mountOverlay: (host: HTMLElement) => OverlayHarness
let harness: OverlayHarness | undefined
let host: HTMLElement | undefined
let frames: Map<number, FrameRequestCallback>
let frameId = 0

// Per-element @vue:unmounted is ignored by Vapor. Exercise the production
// compiler and runtime so leave callbacks depend on supported component hooks.
beforeAll(async () => {
  const fixture = `<script setup lang="ts">
import { reactive } from "vue"
import FocusOverlay from "./FocusOverlay.vue"
const state = reactive({ content: { title: "Preview", source: { entryId: "entry-1" } } as { title: string; source: { entryId: string } } | undefined, leaves: 0, presentAtLeave: false })
function afterLeave() { state.leaves++; state.presentAtLeave = !!document.querySelector("[data-vapor-focus-overlay]") }
defineExpose({ state })
</script>
<template><FocusOverlay :content="state.content" data-vapor-focus-overlay @after-leave="afterLeave" v-slot="{ content }"><span :data-source="content.source.entryId">{{ content.title }}</span></FocusOverlay></template>`
  const result = await build({
    stdin: {
      contents: `import { createApp, nextTick, vaporInteropPlugin } from "vue"
import Fixture from "./FocusOverlayFixture.vue"
export function mount(host) {
  const errors = []
  const app = createApp(Fixture).use(vaporInteropPlugin)
  app.config.errorHandler = error => errors.push(error)
  const { state } = app.mount(host)
  return { state, errors, flush: () => nextTick(), unmount: () => app.unmount() }
}`,
      resolveDir: import.meta.dirname,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "focusOverlayFixture",
    define: { "process.env.NODE_ENV": '"production"', __VUE_OPTIONS_API__: "true", __VUE_PROD_DEVTOOLS__: "false", __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false" },
    plugins: [{ name: "focus-overlay-vapor", setup(plugin) {
      plugin.onResolve({ filter: /FocusOverlayFixture\.vue$/ }, args => ({ path: resolve(args.resolveDir, args.path) }))
      plugin.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
        const source = path.endsWith("FocusOverlayFixture.vue") ? fixture : await readFile(path, "utf8")
        const { descriptor } = parse(source, { filename: path })
        const compiled = compileScript(descriptor, { id: path, inlineTemplate: true, isProd: true, vapor: true })
        return { contents: compiled.content, loader: "ts", resolveDir: dirname(path) }
      })
    } }],
  })
  mountOverlay = new Function(`${result.outputFiles[0]!.text}; return focusOverlayFixture.mount`)() as typeof mountOverlay
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance"] })
  frames = new Map()
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  host = document.createElement("div")
  document.body.appendChild(host)
  harness = mountOverlay(host)
})
afterEach(() => {
  harness?.unmount()
  harness = undefined
  host?.remove()
  host = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})
async function tick(duration: number) {
  for (let elapsed = 0; elapsed < duration; elapsed += 16) {
    vi.advanceTimersByTime(16)
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(performance.now())
    await harness!.flush()
  }
}

test("Vapor retains the closing slot and reports normal exit and parent teardown after DOM removal", async () => {
  await tick(2000)
  harness!.state.content = undefined
  await harness!.flush()
  expect(host!.querySelector("span")?.textContent).toBe("Preview")
  expect(host!.querySelector("span")?.getAttribute("data-source")).toBe("entry-1")
  expect(harness!.state.leaves).toBe(0)
  await tick(2000)
  expect(host!.querySelector("[data-vapor-focus-overlay]")).toBeNull()
  expect(harness!.state.leaves).toBe(1)
  expect(harness!.state.presentAtLeave).toBe(false)
  harness!.state.content = { title: "Reopened", source: { entryId: "entry-2" } }
  await harness!.flush()
  await tick(64)
  const current = harness!
  current.unmount()
  harness = undefined
  expect(current.state.leaves).toBe(2)
  expect(current.state.presentAtLeave).toBe(false)
  expect(frames.size).toBe(0)
  expect(current.errors).toEqual([])
})
