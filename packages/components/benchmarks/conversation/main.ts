import { configureClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { createPinia, disposePinia } from "pinia"
import { createApp, vaporInteropPlugin } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import type { BenchmarkOptions } from "./fixture.ts"
import "virtual:uno.css"
import "../../src/styles.css"

// The fixture exercises rendering only; no machine/account transport is connected.
configureClient({ platform: "linux", locale: "en-US" } as DeskfleetDesktopApi)
const benchmarkReady = Promise.all([import("./Harness.vue"), import("../../src/i18n/index.ts")]).then(([{ default: Harness }, { i18n }]) => {
  const runConversationBenchmark = async (options: BenchmarkOptions) => {
    const pinia = createPinia()
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: { render: () => null } }] })
    const app = createApp(Harness, { options })
    app.use(vaporInteropPlugin)
    app.use(pinia)
    app.use(router)
    app.use(i18n)
    await router.isReady()
    const started = performance.now()
    performance.mark("conversation-mount-start")
    const instance = app.mount("#app") as unknown as { run(started: number): Promise<unknown> }
    try { return await instance.run(started) }
    finally { app.unmount(); disposePinia(pinia) }
  }
  const runIsolatedMarkdownBenchmark = async (options: { renderer: "upstream" | "upstream-hook" | "deskfleet"; corpus: "prose" | "rich"; chunks: number; intervalMs: number; repeats?: number }) => {
    const { default: IsolatedMarkdown } = await import("./IsolatedMarkdown.vue")
    const pinia = createPinia()
    const app = createApp(IsolatedMarkdown, { options })
    app.use(vaporInteropPlugin)
    app.use(pinia)
    app.use(i18n)
    const started = performance.now()
    const instance = app.mount("#app") as unknown as { run(started: number): Promise<unknown> }
    try { return await instance.run(started) }
    finally { app.unmount(); disposePinia(pinia) }
  }
  Object.assign(window, { runConversationBenchmark, runIsolatedMarkdownBenchmark })
})
Object.assign(window, { benchmarkReady })
