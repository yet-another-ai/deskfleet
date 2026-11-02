<script setup lang="ts">
import type { AppLocale } from "@deskfleet/client/i18n"
import { computed, nextTick, onMounted, ref } from "vue"
import { Bot, MonitorPlay, MousePointerClick, Users } from "@lucide/vue"
import ProductDemo from "../demos/ProductDemo.vue"
import type { ProductDemoOptions } from "../demos/product-demo-runtime.ts"
import { useRevealOnce } from "./home-motion.ts"
import { homeCopy } from "./home-locales.ts"

type ChapterKey = "agents" | "remote" | "team"

const props = withDefaults(defineProps<{ locale?: AppLocale }>(), { locale: "en-US" })
const root = ref<HTMLElement>()
const tabs = ref<HTMLButtonElement[]>([])
const shown = useRevealOnce(root, 0.12)
const t = computed(() => homeCopy[props.locale].showcase)

// Each chapter opens on the view that shows its point without a click first.
// Narrow windows cannot fit a conversation beside its changes, so agents start on a new session there.
const demos: Record<ChapterKey, { icon: typeof Bot } & Pick<ProductDemoOptions, "kind" | "initialRoute">> = {
  agents: { icon: Bot, kind: "agents", initialRoute: "/sessions/301" },
  remote: { icon: MonitorPlay, kind: "remote" },
  team: { icon: Users, kind: "team" },
}
const narrow = ref(false)
const chapters = computed(() => t.value.panels.map(panel => {
  const demo = demos[panel.key as ChapterKey]
  return { ...panel, ...demo, initialRoute: narrow.value ? undefined : demo.initialRoute }
}))

const selected = ref(0)
// Demos mount on first visit and then stay alive, so a reader's changes survive switching.
// The first one waits for the viewport so its starting route never changes after mounting.
const opened = ref<boolean[]>([false, false, false])
onMounted(() => {
  narrow.value = matchMedia("(max-width: 760px)").matches
  opened.value[selected.value] = true
})
const current = computed(() => chapters.value[selected.value]!)

function select(index: number, focus = false) {
  selected.value = index
  opened.value[index] = true
  const tab = tabs.value[index]
  if (!tab) return
  if (focus) tab.focus()
  // Narrow layouts scroll the tab strip; keep the chosen chapter in view.
  nextTick(() => tab.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" }))
}

function onKeydown(event: KeyboardEvent, index: number) {
  const last = chapters.value.length - 1
  const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: last }[event.key]
  if (next === undefined) return
  event.preventDefault()
  select((next + last + 1) % (last + 1), true)
}
</script>

<template>
  <section id="explore" ref="root" class="showcase reveal" :class="{ 'is-shown': shown }" :aria-label="t.label">
    <header class="showcase__intro">
      <p class="home-kicker reveal-line" style="--line: 0">{{ t.kicker }}</p>
      <h2 class="showcase__heading reveal-line" style="--line: 1">{{ t.title }}</h2>
      <p class="showcase__note reveal-line" style="--line: 2">{{ t.note }}</p>
    </header>

    <div class="showcase__tabs reveal-line" style="--line: 3" role="tablist" :aria-label="t.chooseDemo">
      <button
        v-for="(chapter, i) in chapters"
        :id="`showcase-tab-${chapter.key}`"
        :key="chapter.key"
        ref="tabs"
        type="button"
        role="tab"
        class="showcase__tab"
        :aria-selected="i === selected"
        :aria-controls="`showcase-panel-${chapter.key}`"
        :tabindex="i === selected ? 0 : -1"
        @click="select(i)"
        @keydown="onKeydown($event, i)"
      >
        <span class="showcase__tab-head">
          <span class="showcase__tab-icon"><component :is="chapter.icon" :size="16" :stroke-width="2" aria-hidden="true" /></span>
          <span>{{ chapter.tab }}</span>
          <span class="showcase__tab-index" aria-hidden="true">{{ String(i + 1).padStart(2, "0") }}</span>
        </span>
        <span class="showcase__tab-title">{{ chapter.title }}</span>
        <span class="showcase__tab-body">{{ chapter.body }}</span>
      </button>
    </div>

    <div class="showcase__window reveal-line" style="--line: 4">
      <div class="showcase__glow" aria-hidden="true" />
      <div class="showcase__chrome">
        <span class="showcase__lights" aria-hidden="true"><i /><i /><i /></span>
        <p class="showcase__hint" aria-live="polite">
          <MousePointerClick :size="15" :stroke-width="2" aria-hidden="true" />
          <span><strong>{{ t.tryIt }}</strong> {{ current.hint }}</span>
        </p>
        <span class="showcase__live"><i aria-hidden="true" />{{ t.live }}</span>
      </div>
      <div class="showcase__stage">
        <div
          v-for="(chapter, i) in chapters"
          :id="`showcase-panel-${chapter.key}`"
          :key="chapter.key"
          role="tabpanel"
          class="showcase__panel"
          :class="{ 'is-active': i === selected }"
          :aria-labelledby="`showcase-tab-${chapter.key}`"
          :inert="i !== selected"
          :data-demo-panel="chapter.key"
        >
          <ProductDemo v-if="opened[i]" :kind="chapter.kind" :initial-route="chapter.initialRoute" :locale="locale" />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.showcase { position: relative; isolation: isolate; width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: clamp(96px, 12vw, 150px) 0 0; scroll-margin-top: var(--home-sticky-top, 0px); }
.showcase__intro { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 0.8fr); align-items: end; gap: 12px 48px; margin-bottom: clamp(32px, 4vw, 48px); }
.showcase__intro .home-kicker { grid-column: 1 / -1; margin: 0; }
.showcase__heading { margin: 0; font-size: clamp(36px, 5vw, 60px); font-weight: 780; letter-spacing: -0.045em; line-height: 1.04; text-wrap: balance; word-break: auto-phrase; }
.showcase__note { margin: 0 0 6px; color: var(--home-ink-2); font-size: clamp(16px, 1.5vw, 18px); line-height: 1.55; text-wrap: pretty; }

/* Chapter tabs: every value proposition is readable before any interaction. */
.showcase__tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
.showcase__tab { position: relative; display: flex; flex-direction: column; gap: 10px; padding: 18px 20px 20px; overflow: hidden; border: 1px solid var(--home-edge); border-radius: 18px; color: var(--home-ink-2); background: transparent; font: inherit; text-align: left; cursor: pointer; transition: background 200ms ease, border-color 200ms ease, box-shadow 200ms ease; }
.showcase__tab::before { position: absolute; inset: 0 0 auto; height: 2px; background: var(--ui-color-action); content: ""; transform: scaleX(0); transform-origin: left; transition: transform 500ms var(--home-ease); }
.showcase__tab:hover { background: var(--home-fill); }
.showcase__tab:focus-visible { outline: 2px solid var(--ui-color-focus); outline-offset: 3px; }
.showcase__tab[aria-selected="true"] { border-color: color-mix(in srgb, var(--ui-color-action) 40%, var(--home-edge)); background: var(--home-panel); box-shadow: 0 22px 44px -28px var(--home-shadow); }
.showcase__tab[aria-selected="true"]::before { transform: none; }
.showcase__tab-head { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 650; }
.showcase__tab-icon { display: grid; width: 28px; height: 28px; flex: none; place-items: center; border-radius: 8px; background: var(--home-fill); transition: background 200ms ease, color 200ms ease; }
.showcase__tab[aria-selected="true"] .showcase__tab-icon { color: var(--ui-color-action-text); background: var(--ui-color-action); }
.showcase__tab[aria-selected="true"] .showcase__tab-head { color: var(--home-ink); }
.showcase__tab-index { margin-left: auto; color: var(--ui-color-text-faint); font-family: var(--vp-font-family-mono); font-size: 12px; font-weight: 500; }
.showcase__tab-title { color: color-mix(in srgb, var(--home-ink) 78%, transparent); font-size: 19px; font-weight: 720; letter-spacing: -0.02em; line-height: 1.25; text-wrap: balance; word-break: auto-phrase; transition: color 200ms ease; }
.showcase__tab[aria-selected="true"] .showcase__tab-title, .showcase__tab:hover .showcase__tab-title { color: var(--home-ink); }
.showcase__tab-body { font-size: 14px; line-height: 1.55; text-wrap: pretty; }

/* The demo window: real application, framed as a desktop window. */
.showcase__window { position: relative; }
.showcase__glow { position: absolute; z-index: -1; inset: 8% 6% -6%; border-radius: 50%; background: radial-gradient(closest-side, color-mix(in srgb, var(--ui-color-action) 26%, transparent), transparent); filter: blur(60px); pointer-events: none; }
.showcase__chrome { display: flex; min-height: 46px; align-items: center; gap: 16px; padding: 8px 14px 8px 16px; border: 1px solid var(--home-edge); border-bottom: 0; border-radius: 16px 16px 0 0; background: var(--ui-color-sidebar); }
.showcase__lights { display: flex; flex: none; gap: 7px; }
.showcase__lights i { width: 11px; height: 11px; border-radius: 50%; background: var(--ui-color-border-strong); }
.showcase__hint { display: flex; min-width: 0; flex: 1; align-items: flex-start; justify-content: center; gap: 8px; margin: 0; color: var(--home-ink-2); font-size: 13px; line-height: 1.45; text-align: left; }
.showcase__hint svg { flex: none; margin-top: 2px; color: var(--ui-color-action); }
.showcase__hint strong { margin-right: 4px; color: var(--home-ink); font-weight: 650; }
.showcase__live { display: inline-flex; flex: none; align-items: center; gap: 6px; padding: 3px 10px; border: 1px solid var(--home-edge); border-radius: 999px; color: var(--home-ink-2); font-size: 11px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; }
.showcase__live i { width: 6px; height: 6px; border-radius: 50%; background: var(--ui-color-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-color-success) 22%, transparent); }
.showcase__stage { position: relative; display: grid; height: clamp(500px, 74svh, 680px); overflow: hidden; border: 1px solid var(--home-edge); border-radius: 0 0 16px 16px; background: var(--home-window); box-shadow: 0 40px 80px -36px var(--home-shadow), 0 3px 12px var(--home-shadow-near); }
.showcase__panel { grid-area: 1 / 1; min-width: 0; min-height: 0; opacity: 0; transform: translateY(10px) scale(0.99); visibility: hidden; transition: opacity 280ms ease, transform 420ms var(--home-ease), visibility 0s linear 420ms; }
.showcase__panel.is-active { opacity: 1; transform: none; visibility: visible; transition: opacity 320ms ease 60ms, transform 520ms var(--home-ease) 60ms, visibility 0s; }
.showcase__panel > :deep(.product-demo) { height: 100%; }

@media (max-width: 960px) {
  .showcase__intro { grid-template-columns: 1fr; }
}
@media (max-width: 900px) {
  .showcase__tab-title { font-size: 17px; }
  .showcase__tab-body { font-size: 13px; }
}

/* Narrow pages scroll the chapters sideways so the demo stays close to its tab. */
@media (max-width: 760px) {
  .showcase { width: calc(100% - 32px); }
  .showcase__tabs { grid-template-columns: none; grid-auto-columns: min(300px, 82%); grid-auto-flow: column; margin: 0 -16px 14px; padding: 2px 16px 6px; overflow-x: auto; scroll-padding-inline: 16px; scroll-snap-type: x mandatory; scrollbar-width: none; }
  .showcase__tabs::-webkit-scrollbar { display: none; }
  .showcase__tab { scroll-snap-align: start; }
  .showcase__lights, .showcase__live { display: none; }
  .showcase__chrome { padding: 10px 14px; }
  .showcase__hint { justify-content: flex-start; font-size: 12px; }
  .showcase__stage { height: clamp(460px, 72svh, 620px); }
}

@media (prefers-reduced-motion: reduce) {
  .showcase__tab, .showcase__tab::before, .showcase__panel, .showcase__panel.is-active { transition: none; }
}
</style>
