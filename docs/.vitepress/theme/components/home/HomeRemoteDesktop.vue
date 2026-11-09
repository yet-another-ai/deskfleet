<script setup lang="ts">
import type { AppLocale } from "@deskfleet/client/i18n"
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { Monitor } from "@lucide/vue"
import { useAnimationClock, usePrefersReducedMotion, useRevealOnce } from "./home-motion.ts"
import { remoteDesktopCopy } from "./remote-desktop-locales.ts"

const props = withDefaults(defineProps<{ locale?: AppLocale }>(), { locale: "en-US" })
const t = computed(() => remoteDesktopCopy[props.locale])
const root = ref<HTMLElement>()
const screen = ref<HTMLElement>()
const shown = useRevealOnce(root, 0.12)
const reduced = usePrefersReducedMotion()
const time = useAnimationClock(screen, reduced, 1.2)

// The remote cursor follows the reader's pointer; otherwise it wanders on its own.
const pointer = ref<{ x: number; y: number }>()
let fine: MediaQueryList | undefined
onMounted(() => { fine = matchMedia("(hover: hover) and (pointer: fine)") })
onBeforeUnmount(() => { fine = undefined })
function track(event: PointerEvent) {
  if (!fine?.matches || event.pointerType === "touch" || !screen.value) return
  const rect = screen.value.getBoundingClientRect()
  pointer.value = { x: (event.clientX - rect.left) / rect.width * 100, y: (event.clientY - rect.top) / rect.height * 100 }
}
const cursor = computed(() => pointer.value ?? {
  x: 58 + Math.sin(time.value * 0.62) * 22,
  y: 52 + Math.sin(time.value * 0.94 + 0.8) * 18,
})
</script>

<template>
  <section id="remote-desktop" ref="root" class="remote reveal" :class="{ 'is-shown': shown, 'is-reduced': reduced }" aria-labelledby="remote-title">
    <header class="remote__intro">
      <p class="home-kicker reveal-line" style="--line: 0">{{ t.kicker }}</p>
      <h2 id="remote-title" class="remote__title reveal-line" style="--line: 1">{{ t.title }}</h2>
      <p class="remote__lead reveal-line" style="--line: 2">{{ t.lead }}</p>
    </header>

    <div class="viewer reveal-line" style="--line: 3">
      <div class="viewer__glow" aria-hidden="true" />
      <div class="viewer__chrome" aria-hidden="true">
        <span class="viewer__lights"><i /><i /><i /></span>
        <span class="viewer__title"><Monitor :size="14" :stroke-width="2" />{{ t.viewer }} · {{ t.machine }}</span>
        <span class="viewer__live"><i />{{ t.live }}</span>
      </div>
      <div
        ref="screen"
        class="screen"
        role="img"
        :aria-label="t.viewerLabel"
        @pointermove="track"
        @pointerleave="pointer = undefined"
      >
        <div class="screen__bar" aria-hidden="true"><i /><i /><i /><i /></div>
        <div class="editor" aria-hidden="true">
          <div class="editor__bar"><i /><i /><i /><span>main.rs</span></div>
          <div class="editor__view">
            <div class="editor__code">
              <template v-for="copy in 2" :key="copy">
                <span v-for="n in 24" :key="`${copy}-${n}`" class="editor__line" :style="{ '--indent': (n * 7) % 4, '--w': 28 + ((n * 37) % 58) + '%', '--hue': n % 5 }" />
              </template>
            </div>
          </div>
        </div>
        <div class="term" aria-hidden="true">
          <div class="editor__bar"><i /><i /><i /><span>cargo test</span></div>
          <div class="term__lines">
            <span v-for="n in 9" :key="n" :style="{ '--n': n, '--w': 30 + ((n * 23) % 55) + '%' }" />
          </div>
        </div>

        <dl class="hud">
          <div><dt>{{ t.hud.codec }}</dt><dd>AV1</dd></div>
          <div><dt>{{ t.hud.encoder }}</dt><dd>NVENC</dd></div>
          <div><dt>{{ t.hud.rate }}</dt><dd>60 fps</dd></div>
          <div><dt>{{ t.hud.path }}</dt><dd><i aria-hidden="true" />{{ t.hud.pathValue }}</dd></div>
        </dl>

        <span class="screen__cursor" aria-hidden="true" :style="{ left: `${cursor.x}%`, top: `${cursor.y}%` }">
          <svg viewBox="0 0 16 16" width="20" height="20"><path d="M2 1.5v12.2l3.3-3.1 2.2 4.6 2-1-2.1-4.5h4.5z" /></svg>
        </span>
      </div>
    </div>

    <ul class="remote__stats">
      <li v-for="(stat, i) in t.stats" :key="stat.value" class="reveal-line" :style="{ '--line': 4 + i }">
        <strong>{{ stat.value }}</strong>
        <p>{{ stat.body }}</p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.remote { width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: clamp(96px, 12vw, 150px) 0 0; scroll-margin-top: var(--home-sticky-top, 0px); }
.remote__intro { max-width: 820px; margin: 0 auto clamp(32px, 4vw, 48px); text-align: center; }
.remote__title { margin: 0; font-size: clamp(36px, 5vw, 60px); font-weight: 780; letter-spacing: -0.045em; line-height: 1.04; text-wrap: balance; word-break: auto-phrase; }
.remote__lead { max-width: 680px; margin: 18px auto 0; color: var(--home-ink-2); font-size: clamp(16px, 1.5vw, 18px); line-height: 1.6; text-wrap: balance; }

/* The viewer window around the streamed desktop. */
.viewer { position: relative; max-width: 1040px; margin: 0 auto; }
.viewer__glow { position: absolute; z-index: -1; inset: 6% 4% -8%; border-radius: 50%; background: radial-gradient(closest-side, color-mix(in srgb, var(--ui-color-action) 30%, transparent), transparent); filter: blur(70px); pointer-events: none; }
.viewer__chrome { display: flex; min-height: 42px; align-items: center; gap: 14px; padding: 8px 14px; border: 1px solid var(--home-edge); border-bottom: 0; border-radius: 16px 16px 0 0; color: var(--home-ink-2); background: var(--ui-color-sidebar); font-size: 13px; }
.viewer__lights { display: flex; gap: 7px; }
.viewer__lights i { width: 11px; height: 11px; border-radius: 50%; background: var(--ui-color-border-strong); }
.viewer__title { display: inline-flex; min-width: 0; flex: 1; align-items: center; justify-content: center; gap: 7px; overflow: hidden; color: var(--home-ink); font-weight: 600; white-space: nowrap; }
.viewer__live { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border: 1px solid var(--home-edge); border-radius: 999px; font-size: 11px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; }
.viewer__live i { width: 6px; height: 6px; border-radius: 50%; background: var(--ui-color-danger); animation: remote-pulse 1.6s ease-in-out infinite; }

.screen { position: relative; aspect-ratio: 16 / 9; overflow: hidden; border: 1px solid var(--home-edge); border-radius: 0 0 16px 16px; background: radial-gradient(60% 80% at 80% 10%, color-mix(in srgb, var(--ui-color-accent-alt) 50%, transparent), transparent 60%), radial-gradient(70% 90% at 10% 100%, color-mix(in srgb, var(--ui-color-accent) 55%, transparent), transparent 60%), #141826; box-shadow: 0 40px 80px -36px var(--home-shadow), 0 3px 12px var(--home-shadow-near); cursor: none; container-type: inline-size; }
.screen__bar { position: absolute; right: 0; bottom: 0; left: 0; display: flex; height: 5.5cqw; max-height: 34px; align-items: center; justify-content: center; gap: 1.2cqw; background: rgb(12 14 22 / 55%); backdrop-filter: blur(12px); }
.screen__bar i { width: 2.4cqw; max-width: 18px; aspect-ratio: 1; border-radius: 22%; background: rgb(255 255 255 / 22%); }
.screen__bar i:first-child { background: #8e9bff; }

/* Remote windows with continuous motion: a scrolling editor and a running terminal. */
.editor, .term { position: absolute; overflow: hidden; border: 1px solid rgb(255 255 255 / 10%); border-radius: 1cqw; background: rgb(16 18 28 / 92%); box-shadow: 0 2cqw 4cqw -1.5cqw rgb(0 0 0 / 60%); }
.editor { top: 9%; left: 5%; width: 54%; height: 72%; }
.term { top: 34%; right: 5%; width: 36%; height: 46%; }
.editor__bar { display: flex; height: 3.4cqw; max-height: 26px; align-items: center; gap: 0.7cqw; padding: 0 1.2cqw; border-bottom: 1px solid rgb(255 255 255 / 8%); color: rgb(255 255 255 / 55%); font-family: var(--vp-font-family-mono); font-size: clamp(8px, 1.1cqw, 12px); }
.editor__bar i { width: 0.9cqw; max-width: 8px; aspect-ratio: 1; border-radius: 50%; background: rgb(255 255 255 / 20%); }
.editor__bar span { margin-left: 1cqw; }
.editor__view { position: absolute; inset: 3.4cqw 0 0; overflow: hidden; mask-image: linear-gradient(transparent, black 12%, black 88%, transparent); }
.editor__code { display: grid; gap: 1.15cqw; padding: 1.4cqw 2cqw; animation: remote-scroll 14s linear infinite; animation-play-state: var(--play, running); }
.editor__line { display: block; width: var(--w); height: 0.75cqw; margin-left: calc(var(--indent) * 2.4cqw); border-radius: 0.4cqw; background: hsl(calc(230 + var(--hue) * 28) 70% 72% / 0.75); }
.term__lines { display: grid; gap: 1cqw; padding: 1.4cqw 1.6cqw; }
.term__lines span { display: block; width: var(--w); height: 0.7cqw; border-radius: 0.35cqw; background: rgb(255 255 255 / 30%); opacity: 0; animation: remote-type 6s steps(1) infinite; animation-delay: calc(var(--n) * 0.45s); }
.term__lines span:nth-child(3n) { background: #4cc38a; }

.hud { position: absolute; top: 4cqw; right: 3cqw; display: grid; min-width: 180px; gap: 6px; margin: 0; padding: 12px 14px; border: 1px solid rgb(255 255 255 / 14%); border-radius: 12px; color: white; background: rgb(10 12 20 / 62%); backdrop-filter: blur(14px) saturate(1.3); font-size: 12px; }
.hud div { display: flex; justify-content: space-between; gap: 18px; }
.hud dt { color: rgb(255 255 255 / 60%); }
.hud dd { display: inline-flex; align-items: center; gap: 6px; margin: 0; font-family: var(--vp-font-family-mono); font-weight: 600; }
.hud dd i { width: 6px; height: 6px; border-radius: 50%; background: #4cc38a; box-shadow: 0 0 0 3px rgb(76 195 138 / 25%); }

.screen__cursor { position: absolute; z-index: 3; margin: -2px 0 0 -2px; filter: drop-shadow(0 2px 3px rgb(0 0 0 / 50%)); pointer-events: none; }
.screen__cursor path { fill: white; stroke: #111; stroke-width: 1.1; stroke-linejoin: round; }

.remote__stats { display: grid; max-width: 1040px; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 28px; margin: clamp(36px, 4.5vw, 56px) auto 0; padding: 0; list-style: none; }
.remote__stats li { position: relative; padding-top: 16px; border-top: 1px solid var(--home-edge); }
.remote__stats strong { display: block; color: var(--home-ink); font-size: clamp(26px, 2.8vw, 34px); font-weight: 780; letter-spacing: -0.035em; line-height: 1.1; }
.remote__stats p { margin: 8px 0 0; color: var(--home-ink-2); font-size: 14px; line-height: 1.55; text-wrap: pretty; }

@keyframes remote-scroll { to { transform: translateY(-50%); } }
@keyframes remote-type { 0% { opacity: 0; } 8%, 100% { opacity: 1; } }
@keyframes remote-pulse { 50% { opacity: 0.35; } }

@media (max-width: 960px) {
  .remote__stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .remote { width: calc(100% - 32px); }
  .viewer__lights, .viewer__live { display: none; }
  .viewer__title { justify-content: flex-start; font-size: 12px; }
  .screen { aspect-ratio: 4 / 3; }
  .editor { width: 64%; height: 62%; }
  .term { top: 30%; width: 44%; height: 40%; }
  .hud { top: auto; right: 10px; bottom: calc(5.5cqw + 8px); left: 10px; min-width: 0; grid-auto-flow: column; justify-content: space-between; padding: 7px 12px; border-radius: 999px; font-size: 11px; }
  .hud dt { display: none; }
  .remote__stats { grid-template-columns: 1fr; }
}

.is-reduced .editor__code, .is-reduced .viewer__live i { animation: none; }
.is-reduced .term__lines span { animation: none; opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .editor__code, .viewer__live i { animation: none; }
  .term__lines span { animation: none; opacity: 1; }
}
</style>
