<script setup lang="ts">
import type { AppLocale } from "@deskfleet/client/i18n"
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import AgentPlayground from "../demos/AgentPlayground.vue"
import RemoteControlDemo from "../demos/RemoteControlDemo.vue"
import CollaborationDemo from "../demos/CollaborationDemo.vue"
import SegmentedControl from "./SegmentedControl.vue"
import { smoothstep, usePrefersReducedMotion, useRevealOnce } from "./home-motion.ts"
import { homeCopy } from "./home-locales.ts"

const props = withDefaults(defineProps<{ locale?: AppLocale }>(), { locale: "en-US" })
const intro = ref<HTMLElement>()
const scroller = ref<HTMLElement>()
const sticky = ref<HTMLElement>()
const reduced = usePrefersReducedMotion()
const shown = useRevealOnce(intro)
const progress = ref(0)
const flowing = ref(false)
const selected = ref(0)
const panels = [AgentPlayground, RemoteControlDemo, CollaborationDemo]
const t = computed(() => homeCopy[props.locale].showcase)
const copy = computed(() => t.value.panels)

const edgeRest = 0.35
const position = computed(() => {
  if (flowing.value) return selected.value
  const x = Math.min(2, Math.max(0, progress.value * (2 + 2 * edgeRest) - edgeRest))
  const index = Math.floor(x)
  return index + smoothstep(0.3, 0.7, x - index)
})
const active = computed(() => Math.round(position.value))
const activeKey = computed(() => copy.value[active.value]!.key)

const topInset = () => sticky.value ? Number.parseFloat(getComputedStyle(sticky.value).top) || 0 : 0
let frame = 0
let shortViewport: MediaQueryList | undefined

function measure() {
  frame = 0
  if (flowing.value || !scroller.value || !sticky.value) return
  const distance = scroller.value.offsetHeight - sticky.value.offsetHeight
  progress.value = distance > 0 ? Math.min(1, Math.max(0, (topInset() - scroller.value.getBoundingClientRect().top) / distance)) : 0
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(measure)
}

function updateLayout() {
  const current = active.value
  flowing.value = shortViewport?.matches ?? false
  selected.value = current
  schedule()
}

onMounted(() => {
  shortViewport = window.matchMedia("(max-height: 640px), (max-width: 640px) and (max-height: 760px)")
  shortViewport.addEventListener("change", updateLayout)
  updateLayout()
  window.addEventListener("scroll", schedule, { passive: true })
  window.addEventListener("resize", schedule)
})
onBeforeUnmount(() => {
  shortViewport?.removeEventListener("change", updateLayout)
  window.removeEventListener("scroll", schedule)
  window.removeEventListener("resize", schedule)
  cancelAnimationFrame(frame)
})

function cardStyle(index: number) {
  const offset = index - position.value
  const distance = Math.min(Math.abs(offset), 2)
  return {
    zIndex: 10 - Math.round(distance * 3),
    opacity: reduced.value ? Number(index === active.value) : Math.max(0, 1 - distance * 0.6),
    filter: reduced.value || distance < 0.01 ? "none" : `blur(${distance * 5}px)`,
    transform: reduced.value || distance < 0.01 ? "none" : `perspective(1800px) translateX(${offset * 64}%) scale(${1 - distance * 0.24}) rotateY(${offset * -16}deg)`,
  }
}

function show(key: string) {
  const element = scroller.value
  const index = copy.value.findIndex(panel => panel.key === key)
  if (!element || !sticky.value || index < 0) return
  if (flowing.value) { selected.value = index; return }
  const top = element.getBoundingClientRect().top + window.scrollY
  const distance = element.offsetHeight - sticky.value.offsetHeight
  window.scrollTo({ top: top - topInset() + distance * (index + edgeRest) / (2 + 2 * edgeRest), behavior: reduced.value ? "instant" : "smooth" })
}
</script>

<template>
  <section id="explore" class="showcase" :aria-label="t.label">
    <header ref="intro" class="showcase__intro reveal" :class="{ 'is-shown': shown }">
      <p class="home-kicker reveal-line" style="--line: 0">{{ t.kicker }}</p>
      <h2 class="home-heading reveal-line" style="--line: 1">{{ t.title }}</h2>
      <p class="showcase__intro-note reveal-line" style="--line: 2">{{ t.note }}</p>
    </header>
    <div ref="scroller" class="showcase__scroller">
      <div ref="sticky" class="showcase__sticky">
        <div class="showcase__stage">
          <div v-for="(panel, i) in copy" :key="panel.key" class="showcase__card" :class="{ 'is-active': i === active }" :style="cardStyle(i)" :inert="i !== active" :aria-hidden="i !== active" :data-demo-panel="panel.key">
            <component :is="panels[i]" :locale="locale" />
          </div>
        </div>
        <div class="showcase__text">
          <article v-for="(panel, i) in copy" :key="panel.key" class="showcase__item reveal" :class="{ 'is-shown': i === active }" :inert="i !== active" :aria-hidden="i !== active">
            <p class="home-kicker reveal-line" style="--line: 0">{{ panel.kicker }}</p>
            <h3 class="showcase__title reveal-line" style="--line: 1">{{ panel.title }}</h3>
            <p class="showcase__body reveal-line" style="--line: 2">{{ panel.body }}</p>
            <p class="showcase__hint reveal-line" style="--line: 3">{{ panel.hint }}</p>
          </article>
        </div>
        <SegmentedControl class="showcase__island" size="small" :label="t.chooseDemo" :options="copy.map(panel => ({ value: panel.key, label: panel.tab }))" :model-value="activeKey" @update:model-value="show" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.showcase { position: relative; scroll-margin-top: var(--home-sticky-top, 0px); }
.showcase__intro { max-width: 800px; margin: 0 auto; padding: clamp(96px, 14vw, 160px) 24px 0; text-align: center; }
.showcase__intro-note { margin: 18px 0 0; color: var(--home-ink-2); font-size: 13px; }
.showcase__scroller { height: 370svh; }
.showcase__sticky { position: sticky; top: var(--home-sticky-top, 0px); display: flex; height: calc(100svh - var(--home-sticky-top, 0px)); flex-direction: column; align-items: center; justify-content: center; gap: clamp(12px, 2svh, 20px); padding: 12px 16px max(16px, env(safe-area-inset-bottom)); overflow: clip; }
.showcase__stage { position: relative; width: min(1100px, 100%); min-height: 0; max-height: 580px; flex: 1 1 0; }
.showcase__card { position: absolute; inset: 0; transform-origin: 50% 60%; pointer-events: none; }
.showcase__card.is-active { pointer-events: auto; }
.showcase__card > :deep(.product-demo) { height: 100%; min-height: 0; max-height: 100%; overflow: auto; border-radius: 16px; box-shadow: 0 30px 70px -25px var(--home-shadow), 0 3px 12px var(--home-shadow-near); }
.showcase__card > :deep(.product-demo > div) { min-height: 0; }
.showcase__text { display: grid; width: min(680px, 100%); flex: none; text-align: center; }
.showcase__item { grid-area: 1 / 1; }
.showcase__item:not(.is-shown) { pointer-events: none; }
.showcase__text .home-kicker { font-size: 11px; margin-bottom: 8px; }
.showcase__title { margin: 0 0 10px; font-size: clamp(24px, 3vw, 34px); font-weight: 750; letter-spacing: -0.025em; line-height: 1.1; }
.showcase__body { margin: 0; color: var(--home-ink-2); font-size: 15px; line-height: 1.6; }
.showcase__hint { margin: 10px 0 0; color: var(--ui-color-text-muted); font-size: 12px; line-height: 1.5; }
.showcase__island { max-width: 100%; flex: none; border: 1px solid var(--home-edge); border-radius: 999px; background: var(--home-panel); box-shadow: 0 10px 30px var(--home-shadow-near); backdrop-filter: blur(20px) saturate(1.4); }
.showcase__island :deep(.segmented__indicator), .showcase__island :deep(.segmented__option) { border-radius: 999px; }
@media (max-width: 640px) {
  .showcase__sticky { gap: 12px; padding-right: 12px; padding-left: 12px; }
  .showcase__body { font-size: 13px; line-height: 1.5; }
  .showcase__title { font-size: 24px; }
}
@media (max-width: 380px) {
  .showcase__island :deep(.segmented__option) { padding-right: 8px; padding-left: 8px; }
}
@media (max-height: 640px), (max-width: 640px) and (max-height: 760px) {
  .showcase__scroller { height: auto; }
  .showcase__sticky { position: relative; top: auto; height: auto; gap: 20px; padding-top: 16px; padding-bottom: 24px; }
  .showcase__stage { height: max(480px, 70svh); max-height: none; flex: none; }
  .showcase__island { order: -1; }
}
</style>
