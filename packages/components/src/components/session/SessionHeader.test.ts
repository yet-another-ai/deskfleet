import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { compileScript, parse } from "@vue/compiler-sfc"
import { build } from "esbuild"
import { afterEach, beforeAll, expect, test } from "vitest"

interface HeaderState {
  ready: boolean
  title: string
  enabled: boolean
  clicks: number
  target?: string
}
interface HeaderHarness {
  state: HeaderState
  errors: Error[]
  update(values: Partial<HeaderState>): Promise<void>
  unmount(): void
}
let mountHeader: (host: HTMLElement, options: { ready: boolean; windowed: boolean; target?: string }) => HeaderHarness
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })

// The normal renderer suite compiles VDOM for Vue Test Utils. This regression
// needs production Vapor compilation and its browser runtime: VDOM alone never
// reproduced the reusable-template registration error.
beforeAll(async () => {
  const fixture = `<script setup lang="ts">
import { computed, provide, reactive } from "vue"
import SessionHeader from "./SessionHeader.vue"
import { windowHeaderActionsTargetKey } from "../chrome/windowHeaderActions.ts"
const props = defineProps<{ ready: boolean; windowed: boolean; target?: string }>()
const state = reactive({ ready: props.ready, title: "First session", enabled: true, clicks: 0, target: props.target })
if (props.windowed) provide(windowHeaderActionsTargetKey, computed(() => state.target))
defineExpose({ state })
</script>
<template>
  <SessionHeader :has-actions="state.ready">
    <span data-session-title>{{ state.title }}</span>
    <template #actions><button v-if="state.ready" data-session-action :disabled="!state.enabled" @click="state.clicks++">{{ state.title }}</button></template>
  </SessionHeader>
  <div v-if="props.windowed" :id="props.target?.slice(1)" data-window-target />
</template>`
  const result = await build({
    stdin: {
      contents: `import { createApp, nextTick, vaporInteropPlugin } from "vue"
import Fixture from "./SessionHeaderFixture.vue"
export function mount(host, options) {
  const errors = []
  const app = createApp(Fixture, options).use(vaporInteropPlugin)
  app.config.errorHandler = error => errors.push(error)
  const { state } = app.mount(host)
  return { state, errors, update: async values => { Object.assign(state, values); await nextTick() }, unmount: () => app.unmount() }
}`,
      resolveDir: import.meta.dirname,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "sessionHeaderFixture",
    define: { "process.env.NODE_ENV": '"production"', __VUE_OPTIONS_API__: "true", __VUE_PROD_DEVTOOLS__: "false", __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false" },
    plugins: [{
      name: "session-header-vapor",
      setup(plugin) {
        plugin.onResolve({ filter: /SessionHeaderFixture\.vue$/ }, args => ({ path: resolve(args.resolveDir, args.path) }))
        plugin.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
          // Keep this test at the header's placement boundary. PaneHeader's own
          // toolbar/store behavior is covered by the normal renderer suite.
          const source = path.endsWith("SessionHeaderFixture.vue") ? fixture
            : path.endsWith("PaneHeader.vue") ? '<script setup>defineOptions({ name: "PaneHeader" })</script><template><header><slot /><slot name="actions" /></header></template>'
            : await readFile(path, "utf8")
          const { descriptor } = parse(source, { filename: path })
          const compiled = compileScript(descriptor, { id: path, inlineTemplate: true, isProd: true, vapor: true })
          return { contents: compiled.content, loader: "ts", resolveDir: dirname(path) }
        })
      },
    }],
  })
  mountHeader = new Function(`${result.outputFiles[0]!.text}; return sessionHeaderFixture.mount`)() as typeof mountHeader
})

function mount(options: { ready: boolean; windowed: boolean; target?: string }): { host: HTMLElement; harness: HeaderHarness; unmount: () => void } {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const harness = mountHeader(host, options)
  let mounted = true
  const unmount = () => { if (mounted) { harness.unmount(); mounted = false } }
  cleanup.push(() => { unmount(); host.remove() })
  return { host, harness, unmount }
}

test.each([false, true])("inline actions render without errors with an initially loaded snapshot: %s", async ready => {
  const { host, harness } = mount({ ready, windowed: false })
  expect(host.querySelector("header")?.textContent).toContain("First session")
  expect(host.querySelectorAll("[data-session-action]")).toHaveLength(ready ? 1 : 0)
  await harness.update({ ready: true })
  const button = host.querySelector<HTMLButtonElement>("[data-session-action]")!
  button.click()
  expect(harness.state.clicks).toBe(1)
  await harness.update({ title: "Second session", enabled: false })
  expect(button.textContent).toBe("Second session")
  expect(button.disabled).toBe(true)
  expect(host.querySelectorAll("[data-session-action]")).toHaveLength(1)
  await harness.update({ ready: false })
  expect(host.querySelector("[data-session-action]")).toBeNull()
  expect(harness.errors).toEqual([])
})

test.each([false, true])("window actions wait for the deferred target and follow its changes with an initially loaded snapshot: %s", async ready => {
  const { host, harness, unmount } = mount({ ready, windowed: true, target: "#session-window-actions" })
  // The fixture creates the target after the session, within the same render.
  const target = host.querySelector<HTMLElement>("[data-window-target]")!
  const other = document.createElement("div")
  other.id = "other-window-actions"
  document.body.appendChild(other)
  cleanup.push(() => { other.remove() })
  await harness.update({ ready: true })
  expect(host.querySelector("header")).toBeNull()
  expect(target.querySelectorAll("[data-session-action]")).toHaveLength(1)
  const button = target.querySelector<HTMLButtonElement>("[data-session-action]")!
  button.click()
  expect(harness.state.clicks).toBe(1)
  await harness.update({ target: "#other-window-actions", title: "Second session" })
  expect(target.querySelector("[data-session-action]")).toBeNull()
  expect(other.querySelector("[data-session-action]")?.textContent).toBe("Second session")
  await harness.update({ ready: false })
  expect(other.querySelector("[data-session-action]")).toBeNull()
  await harness.update({ ready: true })
  expect(other.querySelectorAll("[data-session-action]")).toHaveLength(1)
  unmount()
  expect(other.querySelector("[data-session-action]")).toBeNull()
  expect(harness.errors).toEqual([])
})
