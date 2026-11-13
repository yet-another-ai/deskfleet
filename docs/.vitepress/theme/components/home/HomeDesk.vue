<script setup lang="ts">
import type { AppLocale } from "@deskfleet/client/i18n"
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { deskWindows, type DeskWindow } from "./desk-scenario.ts"
import { usePrefersReducedMotion, useScrollProgress } from "./home-motion"
import { useHeroMotion } from "./hero-motion.ts"
import AppWindow from "./AppWindow.vue"
import { homeCopy } from "./home-locales.ts"

const props = withDefaults(defineProps<{ locale?: AppLocale }>(), { locale: "en-US" })
const t = computed(() => homeCopy[props.locale].desk)
const hero = ref<HTMLElement>()
const reduced = usePrefersReducedMotion()
const leave = useScrollProgress(hero, "leave")
const { x, y, active } = useHeroMotion(hero, reduced)
const assembled = ref(false)
let arrivalFrame = 0

const windows = [
  { key: "fleet", kind: "agents", route: "/", rect: deskWindows.fleet },
  { key: "providers", kind: "agents", route: "/settings/agents", rect: deskWindows.providers },
  { key: "activity", kind: "team", route: "/sessions/303", rect: deskWindows.activity },
  { key: "session", kind: "session", route: "/sessions/301", rect: deskWindows.session },
] as const

function slotStyle(rect: DeskWindow, index: number) {
  return {
    left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.w}%`, height: `${rect.h}%`,
    "--i": index,
    "--depth": `${rect.depth}px`,
    "--pitch": `${rect.pitch}deg`,
    "--yaw": `${rect.yaw}deg`,
    "--roll": `${rect.roll}deg`,
    "--parallax": `${rect.parallax}px`,
    "--gather-x": `${50 - (rect.x + rect.w / 2)}cqw`,
    "--gather-y": `${(48 - (rect.y + rect.h / 2)) * 0.48}cqw`,
    "--exit-x": `${(rect.x + rect.w / 2 - 50) * 14}px`,
    "--exit-y": `${(rect.y + rect.h / 2 - 50) * 7 - 100}px`,
    "--exit-roll": `${rect.roll * 1.8}deg`,
  }
}

const stageStyle = computed(() => {
  const p = reduced.value ? 0 : leave.value
  return {
    "--pointer-x": x.value,
    "--pointer-y": y.value,
    "--leave": p,
    "--play-state": active.value ? "running" : "paused",
    opacity: 1 - p * 0.85,
    filter: p > 0.01 ? `blur(${p * 6}px)` : "none",
  }
})

onMounted(() => {
  arrivalFrame = requestAnimationFrame(() => {
    arrivalFrame = requestAnimationFrame(() => { assembled.value = true })
  })
})
onBeforeUnmount(() => cancelAnimationFrame(arrivalFrame))
</script>

<template>
  <section ref="hero" class="desk" :class="{ 'is-assembled': assembled, 'is-reduced': reduced, 'desk--ja': locale === 'ja-JP' }">
    <div class="desk__viewport">
      <div class="desk__stage" role="img" :aria-label="t.deskLabel" :style="stageStyle">
        <div class="desk__light" aria-hidden="true" />
        <div class="desk__floor" aria-hidden="true" />
        <div class="desk__camera">
          <div v-for="(win, i) in windows" :key="win.key" class="desk__slot" :class="`desk__slot--${win.key}`" :style="slotStyle(win.rect, i)">
            <div class="desk__arrival">
              <div class="desk__pose">
                <div class="desk__float" inert aria-hidden="true">
                  <AppWindow :kind="win.kind" :initial-route="win.route" :locale="locale" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="desk__copy" :class="{ 'is-shown': assembled }">
      <p class="desk__eyebrow">{{ t.heroEyebrow }}</p>
      <h1 class="desk__title"><span v-for="(line, i) in t.heroLines" :key="line" :style="{ '--line': i }">{{ line }}</span></h1>
      <p class="desk__lead">{{ t.heroLead }}</p>
      <div class="desk__actions">
        <a class="home-button home-button--solid" href="#get-deskfleet">{{ t.heroPrimary }}</a>
        <a class="home-button" href="#explore">{{ t.heroSecondary }}</a>
        <a class="home-button" href="https://discord.gg/YmxPdN4HvD" target="_blank" rel="noreferrer">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
          </svg>
          <span>{{ t.heroDiscord }}</span>
        </a>
        <a class="home-button" href="https://x.com/askdeskfleet" target="_blank" rel="noreferrer">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">
            <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
          </svg>
          <span>{{ t.heroX }}</span>
        </a>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* VitePress already reserves the nav's height. Copy sizes itself; the scene
   receives the remaining first-screen space, including after text wraps. */
.desk { position: relative; display: grid; grid-template-rows: minmax(180px, 1fr) auto; height: min(1040px, calc(100svh - var(--vp-nav-height) - var(--vp-layout-top-height, 0px))); min-height: min-content; padding-bottom: 24px; overflow: clip; }
.desk__viewport { position: relative; min-height: 0; container-type: size; }
.desk__stage { position: absolute; left: 50%; bottom: -40px; width: min(1600px, 130vw, calc((100cqh + 40px) * 1440 / 690)); transform: translateX(-50%); container-type: inline-size; aspect-ratio: 1440 / 690; perspective: 1100px; perspective-origin: 50% 42%; }
.desk__camera { position: absolute; inset: 0; transform-style: preserve-3d; transform: rotateX(calc(var(--pointer-y) * -3deg + var(--leave) * 12deg)) rotateY(calc(var(--pointer-x) * 4deg)); }
.desk__light { position: absolute; inset: 0 -10% 8%; pointer-events: none; background: radial-gradient(ellipse at 53% 42%, color-mix(in srgb, var(--ui-color-text) 10%, transparent), transparent 62%); opacity: 0; transition: opacity 1.6s ease 0.3s; }
.is-assembled .desk__light { opacity: 1; }
.desk__floor { position: absolute; inset: 36% -15% -20%; background-image: linear-gradient(var(--ui-color-border) 1px, transparent 1px), linear-gradient(90deg, var(--ui-color-border) 1px, transparent 1px); background-size: 64px 64px; transform: perspective(600px) rotateX(68deg) translateY(calc(var(--pointer-y) * 12px)); mask-image: radial-gradient(ellipse, black, transparent 65%); opacity: 0.4; pointer-events: none; }
.desk__slot { position: absolute; transform-style: preserve-3d; transform: translate3d(calc(var(--leave) * var(--exit-x)), calc(var(--leave) * var(--exit-y)), calc(var(--leave) * 260px)) rotateZ(calc(var(--leave) * var(--exit-roll))); }
.desk__arrival, .desk__pose, .desk__float { width: 100%; height: 100%; transform-style: preserve-3d; }
.desk__arrival { opacity: 0; }
.is-assembled .desk__arrival { animation: desk-arrive 1.9s cubic-bezier(0.2, 0.8, 0.2, 1) calc(var(--i) * 110ms) both; }
.desk__pose { transform: translate3d(calc(var(--pointer-x) * var(--parallax)), calc(var(--pointer-y) * var(--parallax) * 0.65), var(--depth)) rotateX(var(--pitch)) rotateY(var(--yaw)) rotateZ(var(--roll)); }
.desk__float { animation: desk-float 8s ease-in-out calc(var(--i) * -1.9s) infinite alternate; animation-play-state: var(--play-state); }
.desk__slot--session .desk__float { animation-duration: 10s; }
.desk__copy { position: relative; z-index: 2; width: 100%; max-width: 1060px; margin: 0 auto; padding: 0 24px; text-align: center; }
.desk__eyebrow { margin: 0 0 14px; color: var(--ui-color-text-muted); font-size: 12px; font-weight: 650; letter-spacing: 0.12em; text-transform: uppercase; }
.desk__title { margin: 0 0 18px; color: var(--ui-color-text); font-size: clamp(48px, min(6.1vw, 8.5svh), 76px); font-weight: 800; letter-spacing: -0.05em; line-height: 0.98; }
.desk__title span { display: block; }
.desk__eyebrow, .desk__title span, .desk__lead, .desk__actions { opacity: 0; transform: translateY(24px); filter: blur(8px); }
.is-shown .desk__eyebrow, .is-shown .desk__title span, .is-shown .desk__lead, .is-shown .desk__actions { opacity: 1; transform: none; filter: none; transition: opacity 0.8s ease, transform 1s var(--home-ease), filter 0.8s ease; }
.is-shown .desk__eyebrow { transition-delay: 0.32s; }
.is-shown .desk__title span { transition-delay: calc(0.44s + var(--line) * 0.12s); }
.is-shown .desk__lead { transition-delay: 0.7s; }
.is-shown .desk__actions { transition-delay: 0.8s; }
.desk__lead { max-width: 620px; margin: 0 auto; color: var(--ui-color-text-muted); font-size: clamp(17px, 1.7vw, 20px); line-height: 1.55; }
.desk__actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 26px; }

@keyframes desk-arrive {
  0% { opacity: 0; filter: blur(18px); transform: translate3d(var(--gather-x), calc(var(--gather-y) + 28cqw), -1100px) rotateX(70deg) rotateY(-35deg) rotateZ(-38deg) scale(0.35); }
  35% { opacity: 1; filter: blur(2px); }
  60% { opacity: 1; filter: none; transform: translate3d(calc(var(--gather-x) * 0.15), calc(var(--gather-y) * 0.15), -80px) rotateX(24deg) rotateZ(-12deg) scale(0.92); }
  82% { transform: translate3d(0, -12px, 35px) rotateX(-2deg) rotateZ(1deg) scale(1.02); }
  100% { opacity: 1; filter: none; transform: none; }
}
@keyframes desk-float {
  from { transform: translate3d(0, -12px, -5px) rotateZ(-0.6deg); }
  to { transform: translate3d(0, 12px, 8px) rotateZ(0.6deg); }
}

.is-reduced .desk__arrival { animation: none; opacity: 1; transform: none; }
.is-reduced .desk__float { animation: none; }
.is-reduced .desk__light, .is-reduced .desk__copy * { transition: none; }
@media (max-width: 959px) {
  .desk { max-height: 760px; }
}
@media (max-width: 760px) {
  .desk { max-height: 740px; }
  .desk__stage { width: min(780px, calc((100cqh + 24px) * 1440 / 690)); bottom: -24px; perspective: 1000px; }
  .desk__copy { padding: 0 16px; }
  .desk__title { font-size: clamp(38px, 10.8vw, 60px); letter-spacing: -0.045em; }
  .desk--ja .desk__title { font-size: clamp(28px, 8vw, 60px); line-height: 1.15; }
  .desk__eyebrow { font-size: 10px; letter-spacing: 0.08em; }
  .desk__lead { max-width: 480px; font-size: 17px; }
  .desk__floor { background-size: 48px 48px; }
}
@media (max-width: 440px) {
  .desk { max-height: 660px; }
  .desk__stage { max-width: 680px; }
  .desk__actions { margin-top: 22px; }
}
@media (max-height: 500px) {
  .desk { height: auto; max-height: none; }
  .desk__viewport { height: clamp(180px, 38vw, 300px); }
}
</style>
