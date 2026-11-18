import { readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { compileScript, parse } from "@vue/compiler-sfc"
import { build } from "esbuild"
import { afterEach, beforeAll, expect, test, vi } from "vitest"

interface PreviewHarness {
  errors: unknown[]
  setMedia(media: MediaStream | null, state: string): void
  setLocale(locale: string): void
  flush(): Promise<void>
  unmount(): void
}
let mountPreview: (host: HTMLElement) => PreviewHarness
let harness: PreviewHarness | undefined
let host: HTMLElement | undefined

// The ordinary Vue Test Utils suite compiles VDOM. iOS 27's WebKit regression
// affects MediaStream videos cloned from templates, so exercise the production
// Vapor compiler/runtime and observe where the actual card's video is created.
beforeAll(async () => {
  const mocks = `import { ref, shallowRef, h } from "vue"
export const locale = ref("en-US")
export let connection
export function useDesktopConnection() {
  connection = { state: ref("connecting"), stream: shallowRef(null), failure: shallowRef(null), connect: async () => {}, disconnect: async () => {} }
  return connection
}
export function commonPreviewCodecs(codecs) { return codecs.filter(codec => codec === "h264") }
export function useAppearanceStore() { return { isDark: false } }
export function useI18n() { return { locale, t: key => locale.value + ":" + key } }
const Icon = () => h("svg")
export { Icon as ArrowUpRight, Icon as LoaderCircle, Icon as MonitorPlay, Icon as Play, Icon as RefreshCw }
export default { setup(_, { attrs, slots }) { return () => h("button", attrs, slots.default?.()) } }`
  const result = await build({
    stdin: {
      contents: `import { createApp, h, nextTick, vaporInteropPlugin } from "vue"
import DesktopPreviewCard from "./DesktopPreviewCard.vue"
import { connection, locale } from "preview-test-mocks"
export function mount(host) {
  const errors = []
  locale.value = "en-US"
  const app = createApp({ setup: () => () => h(DesktopPreviewCard, {
    api: {}, display: { id: 1, width: 1920, height: 1080, refreshRateHz: 60, codecs: ["h264"] },
    displayIndex: 0, machineName: "Preview host", active: true,
  }) }).use(vaporInteropPlugin)
  app.config.errorHandler = error => errors.push(error)
  app.mount(host)
  return {
    errors,
    setMedia: (media, state) => { connection.stream.value = media; connection.state.value = state },
    setLocale: value => { locale.value = value },
    flush: () => nextTick(), unmount: () => app.unmount(),
  }
}`,
      resolveDir: import.meta.dirname,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "desktopPreviewFixture",
    define: { "process.env.NODE_ENV": '"production"', __VUE_OPTIONS_API__: "true", __VUE_PROD_DEVTOOLS__: "false", __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false" },
    plugins: [{ name: "desktop-preview-vapor", setup(plugin) {
      plugin.onResolve({ filter: /^(preview-test-mocks|@lucide\/vue|vue-i18n)$|\/(useDesktopConnection|appearance)\.ts$|\/(UiButton|ErrorNotice)\.vue$/ }, () => ({ path: "preview-test-mocks", namespace: "preview-test-mocks" }))
      plugin.onLoad({ filter: /.*/, namespace: "preview-test-mocks" }, () => ({ contents: mocks, loader: "js", resolveDir: import.meta.dirname }))
      plugin.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
        const { descriptor } = parse(await readFile(path, "utf8"), { filename: path })
        const compiled = compileScript(descriptor, { id: path, inlineTemplate: true, isProd: true, vapor: true })
        return { contents: compiled.content, loader: "ts", resolveDir: dirname(path) }
      })
    } }],
  })
  mountPreview = new Function(`${result.outputFiles[0]!.text}; return desktopPreviewFixture.mount`)() as typeof mountPreview
})
afterEach(() => {
  harness?.unmount()
  harness = undefined
  host?.remove()
  host = undefined
  vi.restoreAllMocks()
})

test("Vapor creates the preview video in the live document and retains its media binding across updates", async () => {
  const createdVideos = new Set<HTMLVideoElement>()
  const createElement = document.createElement.bind(document)
  vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
    const element = createElement(tag, options)
    if (tag === "video") createdVideos.add(element as HTMLVideoElement)
    return element
  })
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue()
  host = document.createElement("div")
  document.body.appendChild(host)
  harness = mountPreview(host)
  await harness.flush()
  const video = host.querySelector("video")!
  expect(video).not.toBeNull()
  expect(createdVideos.has(video)).toBe(true)
  expect(video.ownerDocument).toBe(document)
  expect(video.muted).toBe(true)
  expect(video.autoplay).toBe(true)
  expect(video.hasAttribute("playsinline")).toBe(true)
  expect([video.getAttribute("width"), video.getAttribute("height")]).toEqual(["320", "180"])
  expect(video.classList.contains("object-contain")).toBe(true)
  expect(video.getAttribute("aria-label")).toBe("en-US:desktop.video")
  expect(video.style.display).toBe("none")

  const stream = new window.MediaStream()
  harness.setMedia(stream, "connected")
  await harness.flush()
  expect(harness.errors).toEqual([])
  expect(video.srcObject).toBe(stream)
  expect(play.mock.contexts).toContain(video)
  expect(video.style.display).toBe("")
  harness.setLocale("ja-JP")
  await harness.flush()
  expect(host.querySelector("video")).toBe(video)
  expect(video.getAttribute("aria-label")).toBe("ja-JP:desktop.video")
  expect(video.srcObject).toBe(stream)

  harness.setMedia(null, "idle")
  await harness.flush()
  expect(video.srcObject).toBeNull()
  expect(video.style.display).toBe("none")
  const current = harness
  current.unmount()
  harness = undefined
  expect(video.isConnected).toBe(false)
  current.setMedia(stream, "connected")
  await current.flush()
  expect(video.srcObject).toBeNull()
  expect(current.errors).toEqual([])
})
