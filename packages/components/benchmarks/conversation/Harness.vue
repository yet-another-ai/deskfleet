<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from "vue"
import AgentConversation from "../../src/components/session/AgentConversation.vue"
import AgentOutline from "../../src/components/session/AgentOutline.vue"
import { projectConversation } from "../../src/services/agent-conversation.ts"
import { CODE_MARKER, createFixture, FINAL_MARKER, type BenchmarkOptions } from "./fixture.ts"
import { verifyConversationScrollback } from "./scrollback.ts"

const props = defineProps<{ options: BenchmarkOptions }>()
const fixture = createFixture(props.options)
const initialEventCount = fixture.events.length
const events = ref(fixture.events)
const snapshot = ref(fixture.snapshot)
const projection = computed(() => projectConversation(events.value, snapshot.value))
const scroller = useTemplateRef<HTMLDivElement>("scroller")
const conversation = useTemplateRef<HTMLDivElement>("conversation")
const locateEntry = ref<string>()
// Match SessionView's post-flush event-count watcher. History mode leaves scroll fixed.
watch(() => events.value.length, () => {
  if (props.options.scroll === "bottom") scroller.value?.scrollTo({ top: scroller.value.scrollHeight })
}, { flush: "post" })

const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve))
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? 0 }
}
function domCounts() {
  const el = conversation.value!
  return {
    elements: el.querySelectorAll("*").length,
    markdown: el.querySelectorAll(".ui-markdown").length,
    codeBlocks: el.querySelectorAll(".ui-code-block").length,
    collapsed: el.querySelectorAll('button[aria-expanded="false"]').length,
    expanded: el.querySelectorAll('button[aria-expanded="true"]').length,
    hiddenElements: el.querySelectorAll("[hidden] *").length,
    diagrams: el.querySelectorAll(".ui-mermaid").length,
    renderedDiagrams: el.querySelectorAll("[data-mermaid-stage] svg").length,
  }
}

function diagramDiagnostics() {
  const diagrams = [...conversation.value!.querySelectorAll<SVGElement>("[data-mermaid-stage] svg")]
  const allIds = new Map<string, number>()
  let unresolvedLocalReferences = 0
  let missingFixtureLabels = 0
  for (const svg of diagrams) {
    const nodes = [svg, ...svg.querySelectorAll("*")]
    const localIds = new Set(nodes.flatMap(node => node.id ? [node.id] : []))
    for (const node of nodes) if (node.id) allIds.set(node.id, (allIds.get(node.id) ?? 0) + 1)
    const references: string[] = []
    for (const node of nodes) {
      for (const attribute of node.attributes) {
        if ((attribute.name === "href" || attribute.name === "xlink:href") && attribute.value.startsWith("#")) references.push(attribute.value.slice(1))
        if (attribute.name === "aria-labelledby" || attribute.name === "aria-describedby") references.push(...attribute.value.split(/\s+/u).filter(Boolean))
      }
    }
    // Includes SVG presentation attributes, inline styles, and embedded stylesheets.
    for (const match of svg.outerHTML.matchAll(/url\(\s*["']?#([^"')\s]+)["']?\s*\)/gu)) references.push(match[1]!)
    unresolvedLocalReferences += references.filter(id => !localIds.has(id)).length
    const labels = [...svg.querySelectorAll(".nodeLabel")].map(node => node.textContent?.trim())
    if (!["Read", "Parse", "Render"].every(label => labels.includes(label))) missingFixtureLabels++
  }
  // Diagnostics run outside the timing window. Legacy renderer ID collisions are
  // reported so the same workload remains runnable against the uncached baseline.
  return {
    renderedDiagrams: diagrams.length,
    duplicateIds: [...allIds.values()].reduce((total, count) => total + Math.max(0, count - 1), 0),
    unresolvedLocalReferences,
    missingFixtureLabels,
  }
}

function closedDisclosures() {
  return [...conversation.value!.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]:not([disabled])')]
    .filter(button => button.hasAttribute("data-turn-work") || button.hasAttribute("data-activity-trigger") || button.classList.contains("group/tool") || button.classList.contains("group/thought"))
}

async function disclosureFrame() {
  // Reka Presence awaits its own nextTick before mounting the disclosure body.
  await nextTick()
  await frame()
  await nextTick()
}

async function openDisclosures() {
  // Opening outer work exposes activity groups, which expose individual tools.
  for (let depth = 0; depth < 4; depth++) {
    await disclosureFrame()
    const buttons = closedDisclosures()
    if (!buttons.length) return
    for (const button of buttons) button.click()
  }
  await disclosureFrame()
  if (closedDisclosures().length) throw new Error("Expanded fixture still contains closed work, thought, activity, or tool disclosures")
}

async function run(mountedAt: number) {
  await nextTick()
  await frame()
  const collapsedAtMount = conversation.value!.querySelectorAll('[data-turn-work][aria-expanded="false"]').length
  if (collapsedAtMount !== props.options.turns) throw new Error(`Expected ${props.options.turns} collapsed historical turns, received ${collapsedAtMount}`)
  const mountMs = performance.now() - mountedAt
  const unfoldStarted = performance.now()
  if (props.options.expanded) await openDisclosures()
  await frame()
  const unfoldMs = performance.now() - unfoldStarted
  if (props.options.scroll === "bottom") scroller.value!.scrollTop = scroller.value!.scrollHeight
  // Settle historical code/diagrams before streaming; report this interval separately.
  const preloadDeadline = performance.now() + 30_000
  let stableHistoryFrames = 0
  let historyText = ""
  while (performance.now() < preloadDeadline && stableHistoryFrames < 3) {
    await frame()
    const el = conversation.value!
    const current = el.textContent ?? ""
    const diagramsReady = el.querySelectorAll(".ui-mermaid").length === el.querySelectorAll("[data-mermaid-stage] svg").length
    stableHistoryFrames = diagramsReady && current === historyText ? stableHistoryFrames + 1 : 0
    historyText = current
  }
  if (stableHistoryFrames < 3) throw new Error("Historical Markdown did not settle within 30 seconds")
  const initialDom = domCounts()
  const frameIntervals: number[] = []
  const deliveryLateness: number[] = []
  const eventToFrame: number[] = []
  let expandDuringStreamMs: number | null = null
  let diagramReopenReadyMs: number | null = null
  let diagramReopenStatus: "not-applicable" | "ready" | "timeout" = "not-applicable"
  let expansion: Promise<void> | undefined
  let diagramReadiness: Promise<void> | undefined
  const longTasks: number[] = []
  const pendingPaints: Promise<void>[] = []
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration)
  })
  const longTasksSupported = PerformanceObserver.supportedEntryTypes.includes("longtask")
  if (longTasksSupported) observer.observe({ type: "longtask" })
  let lastFrame = 0
  let frameId = 0
  let measuring = true
  function sampleFrame(timestamp: number) {
    if (!measuring) return
    if (lastFrame) frameIntervals.push(timestamp - lastFrame)
    lastFrame = timestamp
    frameId = requestAnimationFrame(sampleFrame)
  }
  frameId = requestAnimationFrame(sampleFrame)
  performance.mark("conversation-stream-start")
  const started = performance.now()
  const preStreamSettleMs = started - mountedAt - mountMs - unfoldMs
  let delivered = 0
  let deliveryBatches = 0
  let largestDeliveryBatch = 0
  // Absolute schedule keeps a slow renderer from silently reducing the offered load.
  await new Promise<void>((resolve, reject) => {
    function deliver() {
      try {
        const elapsed = performance.now() - started
        const due = Math.min(fixture.pending.length, Math.floor(elapsed / props.options.intervalMs) + 1)
        const batchStart = delivered
        const deliveryTime = performance.now()
        while (delivered < due) {
          deliveryLateness.push(Math.max(0, deliveryTime - started - delivered * props.options.intervalMs))
          events.value.push(fixture.pending[delivered++]!)
        }
        if (delivered > batchStart) {
          deliveryBatches++
          largestDeliveryBatch = Math.max(largestDeliveryBatch, delivered - batchStart)
          // A Vue-update-to-rAF scheduling proxy, not a content visibility or
          // display presentation timestamp: rAF callbacks run before paint.
          pendingPaints.push(nextTick().then(frame).then(() => {
            const latency = performance.now() - deliveryTime
            for (let index = batchStart; index < due; index++) eventToFrame.push(latency)
          }))
        }
        if (!expansion && delivered >= Math.floor(fixture.pending.length / 2) && props.options.turns > 0) {
          expansion = (async () => {
            const button = conversation.value!.querySelector<HTMLButtonElement>('[data-turn-work]')!
            // Measure an actual expand even in the initially expanded scenario.
            if (button.getAttribute("aria-expanded") === "true") { button.click(); await disclosureFrame() }
            const expandingAt = performance.now()
            button.click()
            await disclosureFrame()
            const response = button.parentElement!
            const activity = response.querySelector<HTMLButtonElement>('[data-activity-trigger]')
            if (!activity) throw new Error("Historical activity group failed to mount")
            if (activity.getAttribute("aria-expanded") === "false") activity.click()
            await disclosureFrame()
            if (button.getAttribute("aria-expanded") !== "true") throw new Error("Historical disclosure failed to open")
            if (activity.getAttribute("aria-expanded") !== "true") throw new Error("Historical activity group failed to open")
            // Outer work + activity expansion through the next frame; this
            // does not include asynchronously completed Mermaid rendering.
            expandDuringStreamMs = performance.now() - expandingAt
            diagramReadiness = (async () => {
              const readyDeadline = expandingAt + 15_000
              while (performance.now() < readyDeadline) {
                const diagrams = response.querySelectorAll(".ui-mermaid")
                if (diagrams.length && diagrams.length === response.querySelectorAll("[data-mermaid-stage] svg").length) {
                  diagramReopenReadyMs = performance.now() - expandingAt
                  diagramReopenStatus = "ready"
                  return
                }
                await frame()
              }
              diagramReopenStatus = "timeout"
            })()
          })()
        }
        if (delivered === fixture.pending.length) { resolve(); return }
        setTimeout(deliver, Math.max(0, started + delivered * props.options.intervalMs - performance.now()))
      } catch (error) { reject(error) }
    }
    deliver()
  })
  const lastDeliveryAt = performance.now()
  performance.mark("conversation-stream-delivered")
  events.value.push(fixture.completion)
  snapshot.value = { ...snapshot.value, turns: [...snapshot.value.turns.slice(0, -1), fixture.completed] }
  await nextTick()
  // End-of-stream moves the final answer out of the completed work disclosure.
  // Inspect only that response, avoiding a history-sized layout/text scan on
  // every settling frame. Require visible prose and highlighted sentinel code.
  const finalResponse = conversation.value!.querySelector<HTMLElement>(":scope > ol > li:last-child")
  if (!finalResponse) throw new Error("Final response did not mount")
  const deadline = lastDeliveryAt + 15_000
  let settledAt = 0
  let previous = ""
  let stableFrames = 0
  while (performance.now() < deadline) {
    await frame()
    const el = finalResponse
    const answerComplete = el.innerText.includes(FINAL_MARKER)
    const codeComplete = [...el.querySelectorAll(".ui-code-block pre code")].some(code =>
      [...code.querySelectorAll(".shiki-stream-stable, .shiki-stream-unstable")]
        .map(tokens => tokens.textContent ?? "").join("").includes(CODE_MARKER),
    )
    const diagramsComplete = el.querySelectorAll(".ui-mermaid").length > 0
      && el.querySelectorAll(".ui-mermaid").length === el.querySelectorAll("[data-mermaid-stage] svg").length
    const current = el.textContent ?? ""
    stableFrames = answerComplete && codeComplete && diagramsComplete && current === previous ? stableFrames + 1 : 0
    previous = current
    if (stableFrames >= 3) { settledAt = performance.now(); break }
  }
  measuring = false
  performance.mark("conversation-final-ready")
  cancelAnimationFrame(frameId)
  await Promise.all(pendingPaints)
  await expansion
  // PerformanceObserver delivery occurs on a later task.
  await delay(0)
  for (const entry of observer.takeRecords()) longTasks.push(entry.duration)
  observer.disconnect()
  if (!settledAt) throw new Error("Final answer/code did not settle within 15 seconds")
  const finalDom = domCounts()
  await diagramReadiness
  const diagramValidation = diagramDiagnostics()
  const historicalTurnIndex = Math.floor(props.options.turns / 2)
  const historicalTurn = props.options.turns ? snapshot.value.turns[historicalTurnIndex] : undefined
  const thought = historicalTurn && projection.value.find(entry => entry.kind === "message" && entry.role === "thought" && entry.turnId === historicalTurn.id)
  const capture = (window as unknown as { captureConversationScrollback?: (name: string) => Promise<void> }).captureConversationScrollback
  const scrollbackValidation = await verifyConversationScrollback(scroller.value!, conversation.value!, {
    locate: thought ? { rowIndex: historicalTurnIndex * 2 + 1, entryId: thought.id, select: async id => { locateEntry.value = id; await nextTick() } } : undefined,
    checkpoint: capture,
  })
  return {
    options: props.options,
    fixture: { initialEvents: initialEventCount, streamedEvents: fixture.pending.length, sourceCharacters: fixture.sourceCharacters },
    mountMs, unfoldMs, preStreamSettleMs, expandDuringStreamMs, diagramReopenReadyMs, diagramReopenStatus, streamMs: lastDeliveryAt - started,
    offeredStreamMs: (fixture.pending.length - 1) * props.options.intervalMs,
    finalCatchupMs: settledAt - lastDeliveryAt,
    eventToFrameMs: distribution(eventToFrame),
    deliveryLatenessMs: distribution(deliveryLateness),
    frameIntervalMs: distribution(frameIntervals),
    longTasks: { supported: longTasksSupported, count: longTasks.length, totalMs: longTasks.reduce((sum, value) => sum + value, 0), maxMs: Math.max(0, ...longTasks) },
    deliveryBatches, largestDeliveryBatch,
    initialDom, finalDom, diagramValidation, scrollbackValidation,
    completed: true,
  }
}
defineExpose({ run })
</script>

<template>
  <div ref="scroller" class="benchmark-scroller">
    <div ref="conversation" class="benchmark-conversation">
      <AgentConversation :events="events" :snapshot="snapshot" :projection="projection" :locate-entry="locateEntry" />
    </div>
  </div>
  <aside class="benchmark-outline"><AgentOutline :events="events" :snapshot="snapshot" :projection="projection" /></aside>
</template>

<style>
html, body, #app { margin: 0; height: 100%; }
html { color-scheme: light; }
body { background: var(--ui-color-canvas); color: var(--ui-color-text); }
.benchmark-scroller { height: 100vh; overflow: auto; }
.benchmark-conversation { max-width: 960px; padding: 32px; margin: 0 auto; }
.benchmark-outline { position: fixed; left: 8px; top: 20%; max-height: 60vh; }
</style>
