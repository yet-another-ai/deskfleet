<script lang="ts">
import { MermaidBlockNode, PreCodeNode, setCustomComponents } from "markstream-vue"
import { defineComponent, h } from "vue"

const UPSTREAM_RICH_ID = "deskfleet-isolated-upstream-rich"
// renderCodeBlocksAsPre also converts Mermaid fences to source text. Preserve
// real diagrams while using upstream's plain code component for regular fences.
// Only rich diagnostics use this map; prose keeps the uncustomized fast path.
setCustomComponents(UPSTREAM_RICH_ID, {
  code_block: defineComponent({
    props: ["node", "loading"],
    setup(props) {
      return () => h(String(props.node?.language ?? "").trim().toLowerCase() === "mermaid" ? MermaidBlockNode : PreCodeNode,
        { node: props.node, loading: props.loading })
    },
  }),
})
</script>

<script setup lang="ts">
import { enableKatex, enableMermaid, MarkdownRender } from "markstream-vue"
import { nextTick, ref, useTemplateRef } from "vue"
import AgentMarkdown from "../../src/components/session/AgentMarkdown.vue"
import { CODE_MARKER, FINAL_MARKER, mixedMarkdown } from "./fixture.ts"
import "markstream-vue/index.css"

const props = defineProps<{ options: {
  renderer: "upstream" | "upstream-hook" | "deskfleet"
  corpus: "prose" | "rich"
  chunks: number
  intervalMs: number
  repeats?: number
} }>()

// Load this harness lazily: these upstream integrations and styles belong only
// to the isolated experiment, not the full-conversation benchmark.
enableKatex(() => import("katex"))
enableMermaid(() => import("mermaid"))

const text = ref("")
const final = ref(false)
const content = useTemplateRef<HTMLDivElement>("content")
// Even a no-op extension selects the parser's custom-extension path. This
// variant isolates that flag from our file-link behavior and custom renderers.
const parserHook = (markdown: any) => markdown
const prose = Array.from({ length: 12 }, (_, index) => `### Investigation ${index}

The renderer should preserve **completed text**, *emphasis*, and \`inline code\` while the next response arrives. 中文段落用于覆盖混合语言文本。

1. Inspect the existing implementation.
2. Measure the update cost.
   - Keep completed work stable.
   - Validate **nested formatting**.

> A result should be reproducible with the same fixture and viewport.

| Stage | Count | State |
| --- | ---: | --- |
| Read | ${index + 1} | complete |
| Render | ${index + 2} | measured |

[Documentation](https://example.com/benchmark).

The measured result for iteration ${index} includes completed paragraphs and tables.
`).join("\n")
const repeats = props.options.repeats ?? 1
const rich = `${mixedMarkdown(3000)}\n${mixedMarkdown(3001)}`
const source = `${(props.options.corpus === "rich" ? rich : prose).repeat(repeats)}\n${props.options.corpus === "rich" ? `\`\`\`typescript\n${CODE_MARKER}\n\`\`\`\n` : ""}\n${FINAL_MARKER}`
const expected = props.options.corpus === "rich"
  ? { math: 4 * repeats, diagrams: repeats, codeBlocks: 3 * repeats + 1 }
  : { math: 0, diagrams: 0, codeBlocks: 0 }
const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve))
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? 0 }
}
function counts() {
  const el = content.value!
  return {
    elements: el.querySelectorAll("*").length,
    tables: el.querySelectorAll("table").length,
    math: el.querySelectorAll(".katex").length,
    diagrams: el.querySelectorAll("[data-mermaid-stage] svg, .mermaid-preview-area ._mermaid svg").length,
    codeBlocks: el.querySelectorAll(".ui-code-block pre code, .markstream-pre__code").length,
    highlightedCodeBlocks: [...el.querySelectorAll(".ui-code-block pre code")].filter(code => code.querySelector(".shiki-stream-stable, .shiki-stream-unstable")).length,
  }
}

async function run(mountedAt: number) {
  await nextTick()
  await frame()
  const mountMs = performance.now() - mountedAt
  const frameIntervals: number[] = []
  const eventToFrame: number[] = []
  const deliveryLateness: number[] = []
  const longTasks: number[] = []
  const pendingPaints: Promise<void>[] = []
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration)
  })
  const longTasksSupported = PerformanceObserver.supportedEntryTypes.includes("longtask")
  if (longTasksSupported) observer.observe({ type: "longtask" })
  let measuring = true
  let lastFrame = 0
  let frameId = 0
  const sample = (timestamp: number) => {
    if (!measuring) return
    if (lastFrame) frameIntervals.push(timestamp - lastFrame)
    lastFrame = timestamp
    frameId = requestAnimationFrame(sample)
  }
  frameId = requestAnimationFrame(sample)
  let delivered = 0
  let deliveryBatches = 0
  let largestDeliveryBatch = 0
  const started = performance.now()
  performance.mark("isolated:stream-start")
  await new Promise<void>(resolve => {
    function deliver() {
      const at = performance.now()
      const due = Math.min(props.options.chunks, Math.floor((at - started) / props.options.intervalMs) + 1)
      const count = due - delivered
      for (; delivered < due; delivered++) deliveryLateness.push(Math.max(0, at - started - delivered * props.options.intervalMs))
      if (count > 0) {
        text.value = source.slice(0, Math.floor(source.length * due / props.options.chunks))
        deliveryBatches++
        largestDeliveryBatch = Math.max(largestDeliveryBatch, count)
        pendingPaints.push((async () => {
          await nextTick()
          await frame()
          const latency = performance.now() - at
          for (let index = 0; index < count; index++) eventToFrame.push(latency)
        })())
      }
      if (delivered === props.options.chunks) { resolve(); return }
      setTimeout(deliver, Math.max(0, started + delivered * props.options.intervalMs - performance.now()))
    }
    deliver()
  })
  const lastDeliveryAt = performance.now()
  final.value = true
  performance.mark("isolated:delivery-end")
  await nextTick()
  let previous = ""
  let stableFrames = 0
  let settledAt = 0
  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    await frame()
    const current = content.value!.textContent ?? ""
    const rendered = counts()
    const richReady = rendered.math === expected.math && rendered.diagrams === expected.diagrams
      && rendered.codeBlocks === expected.codeBlocks
    const codeReady = props.options.corpus !== "rich" || (props.options.renderer !== "deskfleet"
      ? current.includes(CODE_MARKER)
      : [...content.value!.querySelectorAll(".ui-code-block pre code")].some(code =>
        [...code.querySelectorAll(".shiki-stream-stable, .shiki-stream-unstable")].map(tokens => tokens.textContent ?? "").join("").includes(CODE_MARKER)))
    stableFrames = current.includes(FINAL_MARKER) && richReady && codeReady && current === previous ? stableFrames + 1 : 0
    previous = current
    if (stableFrames >= 3) { settledAt = performance.now(); break }
  }
  performance.mark("isolated:ready")
  measuring = false
  cancelAnimationFrame(frameId)
  await Promise.all(pendingPaints)
  await delay(0)
  for (const entry of observer.takeRecords()) longTasks.push(entry.duration)
  observer.disconnect()
  const rendered = counts()
  if (!settledAt) throw new Error(`Isolated Markdown did not settle: ${JSON.stringify({ expected, rendered, renderer: props.options.renderer })}`)
  return {
    options: props.options, sourceCharacters: source.length, sourceBytes: new TextEncoder().encode(source).length,
    upstreamPreset: "immediate complete DOM; KaTeX and Mermaid enabled; pacing off; rich only uses a scoped plain-code component override",
    upstreamCustomCodeOverride: props.options.renderer !== "deskfleet" && props.options.corpus === "rich",
    codeSurface: props.options.renderer === "deskfleet" ? "Shiki streaming tokens" : "plain pre",
    mountMs, streamMs: lastDeliveryAt - started, offeredStreamMs: (props.options.chunks - 1) * props.options.intervalMs,
    finalCatchupMs: settledAt - lastDeliveryAt, frameIntervalMs: distribution(frameIntervals),
    eventToFrameMs: distribution(eventToFrame), deliveryLatenessMs: distribution(deliveryLateness),
    deliveryBatches, largestDeliveryBatch,
    longTasks: { supported: longTasksSupported, count: longTasks.length, totalMs: longTasks.reduce((sum, ms) => sum + ms, 0), maxMs: Math.max(0, ...longTasks) },
    expected, rendered, completed: true,
  }
}
defineExpose({ run })
</script>

<template>
  <div ref="content" class="isolated-markdown">
    <AgentMarkdown v-if="options.renderer === 'deskfleet'" :text="text" :final="final" />
    <MarkdownRender v-else :content="text" :final="final" :smooth-streaming="false" :typewriter="false" :fade="false"
      :custom-id="options.corpus === 'rich' ? UPSTREAM_RICH_ID : undefined"
      :custom-markdown-it="options.renderer === 'upstream-hook' ? parserHook : undefined"
      :batch-rendering="false" :max-live-nodes="0" :viewport-priority="false" :defer-nodes-until-visible="false"
      :render-code-blocks-as-pre="false" />
  </div>
</template>

<style scoped>
.isolated-markdown { max-width: 960px; padding: 32px; margin: 0 auto; }
</style>
