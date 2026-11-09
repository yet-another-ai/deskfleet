<script setup lang="ts">
import type { AppLocale } from "@deskfleet/client/i18n"
import { computed, ref } from "vue"
import { withBase } from "vitepress"
import { Blocks, Camera, Check, FolderSync, Laptop, LoaderCircle, Monitor, MousePointer2, MousePointerClick, Network, Server, ShieldCheck, Upload } from "@lucide/vue"
import { useAnimationClock, usePrefersReducedMotion, useRevealOnce } from "./home-motion.ts"
import { cursorAt, packetsAt, progress, relayLoop, relayMoments, relayRestTime, relaySteps, stepState, type RelayStepKey } from "./agent-relay-scenario.ts"
import { agentRelayCopy } from "./agent-relay-locales.ts"

const props = withDefaults(defineProps<{ locale?: AppLocale }>(), { locale: "en-US" })
const t = computed(() => agentRelayCopy[props.locale])
const root = ref<HTMLElement>()
const scene = ref<HTMLElement>()
const shown = useRevealOnce(root, 0.12)
const reduced = usePrefersReducedMotion()
const clock = useAnimationClock(scene, reduced, relayRestTime)
// The clock starts at the rest frame; animated playback begins at the start of the loop.
const time = computed(() => reduced.value ? relayRestTime : (clock.value - relayRestTime) % relayLoop)

const stepIcons: Record<RelayStepKey, typeof Network> = { machines: Network, upload: Upload, open: MousePointerClick, capture: Camera }
const packetLabels: Record<RelayStepKey, string> = { machines: "machines", upload: "file", open: "invoke", capture: "screenshot" }
const featureIcons = [Blocks, MousePointer2, FolderSync, ShieldCheck]
const logo = withBase("/logo.svg")

const steps = computed(() => relaySteps.map(step => ({
  ...step,
  icon: stepIcons[step.key],
  copy: t.value.steps[step.key],
  state: stepState(time.value, step),
})))
const packets = computed(() => packetsAt(time.value).map(packet => ({ ...packet, label: packetLabels[packet.kind] })))
const uploaded = computed(() => progress(time.value, relaySteps[1]!.out))
const cursor = computed(() => cursorAt(time.value))
const at = (moment: number) => time.value >= moment
const operating = computed(() => steps.value.some(step => (step.key === "open" || step.key === "capture") && step.state === "running"))
const flash = computed(() => {
  const since = time.value - relayMoments.flash
  return since < 0 ? 0 : Math.max(0, 1 - since / 0.55)
})
const toast = computed(() => time.value >= relayMoments.flash && time.value < relayMoments.flash + 1.8)
// Fade the whole conversation out before the loop restarts, and keep it hidden
// while items transition back to their initial state.
const presence = computed(() => Math.min(progress(time.value, [0, 0.35]), 1 - progress(time.value, [relayMoments.fadeOut, relayLoop - 0.1])))
</script>

<template>
  <section id="everywhere" ref="root" class="relay reveal" :class="{ 'is-shown': shown, 'is-reduced': reduced }" aria-labelledby="relay-title">
    <header class="relay__intro">
      <p class="home-kicker reveal-line" style="--line: 0">{{ t.kicker }}</p>
      <h2 id="relay-title" class="relay__title reveal-line" style="--line: 1">{{ t.title }}</h2>
      <p class="relay__lead reveal-line" style="--line: 2">{{ t.lead }}</p>
    </header>

    <div ref="scene" class="relay__scene reveal-line" style="--line: 3" role="img" :aria-label="t.sceneLabel">
      <div class="relay__glow" aria-hidden="true" />

      <!-- The agent's own machine: a conversation with remote tool-call cards. -->
      <div class="machine machine--local" aria-hidden="true">
        <div class="machine__bar">
          <Laptop :size="15" :stroke-width="2" />
          <span class="machine__name">{{ t.local.name }}</span>
          <span class="machine__chip">{{ t.local.agent }}</span>
        </div>
        <div class="chat" :style="{ opacity: presence }">
          <div class="chat__prompt" :class="{ 'is-in': at(relayMoments.prompt) }">
            <span class="chat__author">{{ t.author }}</span>
            <p>{{ t.prompt }}</p>
          </div>
          <div v-for="step in steps" :key="step.key" class="call" :class="[`is-${step.state}`, `call--${step.key}`]">
            <span class="call__icon"><component :is="step.icon" :size="14" :stroke-width="2.1" /></span>
            <span class="call__main">
              <span class="call__head">
                <strong>{{ step.copy.action }}</strong>
                <span class="call__target"><Monitor :size="11" :stroke-width="2.2" />{{ t.remote.name }}</span>
              </span>
              <code class="call__tool">{{ step.tool }}</code>
              <span v-if="step.key === 'upload' && step.state === 'running'" class="call__bar"><i :style="{ transform: `scaleX(${uploaded})` }" /></span>
              <span v-else class="call__result">{{ step.copy.result }}</span>
              <span v-if="step.key === 'capture'" class="thumb" :class="{ 'is-in': step.state === 'done' }">
                <span class="thumb__window"><i /><b /><b /><em /></span>
              </span>
            </span>
            <span class="call__state">
              <LoaderCircle v-if="step.state === 'running'" class="call__spinner" :size="14" :stroke-width="2.2" />
              <Check v-else :size="14" :stroke-width="2.6" />
            </span>
          </div>
          <p class="chat__reply" :class="{ 'is-in': at(relayMoments.reply) }">{{ t.reply }}</p>
        </div>
      </div>

      <!-- Requests and results pass through the Team server's management transport. -->
      <div class="lane" aria-hidden="true">
        <span class="lane__track" />
        <span class="lane__server"><Server :size="16" :stroke-width="2" /><small>{{ t.server }}</small></span>
        <span
          v-for="packet in packets"
          :key="packet.key"
          class="packet"
          :class="`packet--${packet.direction}`"
          :style="{ '--at': packet.at }"
        >
          <i />
          <code v-if="packet.direction === 'out'">{{ packet.label }}</code>
        </span>
      </div>

      <!-- The target machine's desktop, operated through computer use. -->
      <div class="machine machine--remote" aria-hidden="true">
        <div class="machine__bar">
          <Monitor :size="15" :stroke-width="2" />
          <span class="machine__name">{{ t.remote.name }}</span>
          <span class="machine__chip" :class="{ 'is-live': operating }"><i />{{ t.remote.agent }}</span>
        </div>
        <div class="desktop">
          <div class="desktop__layer" :style="{ opacity: presence }">
            <span class="desktop__file" :class="{ 'is-in': at(relayMoments.fileArrives), 'is-picked': at(relayMoments.doubleClick) }">
              <span class="desktop__file-icon"><img :src="logo" alt=""></span>
              <span class="desktop__file-name">{{ t.file }}</span>
            </span>
            <div class="installer" :class="{ 'is-in': at(relayMoments.installerOpens) }">
              <div class="installer__bar"><span>{{ t.installer.title }}</span><span class="installer__controls"><i /><i /><i /></span></div>
              <div class="installer__body">
                <img :src="logo" alt="">
                <div>
                  <strong>{{ t.installer.heading }}</strong>
                  <p>{{ t.installer.body }}</p>
                </div>
              </div>
              <div class="installer__foot"><span>{{ t.installer.next }}</span></div>
            </div>
            <span class="desktop__ripple" :class="{ 'is-on': at(relayMoments.doubleClick) && !at(relayMoments.doubleClick + 0.6) }" />
            <span class="desktop__cursor" :style="{ left: `${cursor.x}%`, top: `${cursor.y}%` }">
              <svg viewBox="0 0 16 16" width="18" height="18"><path d="M2 1.5v12.2l3.3-3.1 2.2 4.6 2-1-2.1-4.5h4.5z" /></svg>
            </span>
            <span class="desktop__flash" :style="{ opacity: flash }" />
            <span class="desktop__toast" :class="{ 'is-in': toast }"><Camera :size="12" :stroke-width="2.2" />{{ t.captured }}</span>
          </div>
          <div class="desktop__taskbar"><i /><i /><i /><i /></div>
        </div>
      </div>
    </div>

    <ul class="relay__features">
      <li v-for="(feature, i) in t.features" :key="feature.title" class="reveal-line" :style="{ '--line': 4 + i }">
        <span class="relay__feature-icon"><component :is="featureIcons[i]" :size="18" :stroke-width="1.9" aria-hidden="true" /></span>
        <h3>{{ feature.title }}</h3>
        <p>
          <template v-for="(part, j) in feature.body.split('{auv}')" :key="j"><a v-if="j > 0" class="relay__link" href="https://github.com/moeru-ai/auv" target="_blank" rel="noreferrer">@moeru-ai/auv</a>{{ part }}</template>
        </p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.relay { width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: clamp(96px, 12vw, 150px) 0 0; scroll-margin-top: var(--home-sticky-top, 0px); }
.relay__intro { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 0.8fr); align-items: end; gap: 12px 48px; margin-bottom: clamp(32px, 4vw, 48px); }
.relay__intro .home-kicker { grid-column: 1 / -1; margin: 0; }
.relay__title { margin: 0; font-size: clamp(36px, 5vw, 60px); font-weight: 780; letter-spacing: -0.045em; line-height: 1.04; text-wrap: balance; word-break: auto-phrase; }
.relay__lead { margin: 0 0 6px; color: var(--home-ink-2); font-size: clamp(16px, 1.5vw, 18px); line-height: 1.55; text-wrap: pretty; }

/* Scene: agent machine · lane through the Team server · target machine. */
.relay__scene { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) clamp(110px, 12vw, 150px) minmax(0, 1.15fr); align-items: stretch; padding: clamp(18px, 2.4vw, 28px); border: 1px solid var(--home-edge); border-radius: 24px; background: radial-gradient(90% 70% at 50% 0%, color-mix(in srgb, var(--ui-color-action) 9%, transparent), transparent 70%), var(--ui-color-sidebar); }
.relay__glow { position: absolute; z-index: -1; inset: 10% 8% -4%; border-radius: 50%; background: radial-gradient(closest-side, color-mix(in srgb, var(--ui-color-accent-alt) 20%, transparent), transparent); filter: blur(60px); pointer-events: none; }

.machine { display: flex; min-width: 0; flex-direction: column; overflow: hidden; border: 1px solid var(--home-edge); border-radius: 16px; background: var(--home-window); box-shadow: 0 30px 60px -34px var(--home-shadow), 0 2px 8px var(--home-shadow-near); }
.machine__bar { display: flex; min-height: 42px; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--home-edge); color: var(--home-ink-2); background: var(--ui-color-sidebar); font-size: 13px; }
.machine__name { min-width: 0; overflow: hidden; color: var(--home-ink); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.machine__chip { display: inline-flex; flex: none; align-items: center; gap: 6px; margin-left: auto; padding: 2px 9px; border: 1px solid var(--home-edge); border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.machine__chip i { width: 6px; height: 6px; border-radius: 50%; background: var(--ui-color-border-strong); transition: background 200ms ease, box-shadow 200ms ease; }
.machine__chip.is-live { color: var(--home-ink); border-color: color-mix(in srgb, var(--ui-color-success) 45%, var(--home-edge)); }
.machine__chip.is-live i { background: var(--ui-color-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-color-success) 25%, transparent); }

/* Conversation on the agent's machine. */
.chat { display: flex; height: 100%; min-height: 430px; flex-direction: column; gap: 8px; padding: 14px; }
.chat__prompt, .call, .chat__reply { opacity: 0; transform: translateY(8px); transition: opacity 360ms ease, transform 480ms var(--home-ease); }
.chat__prompt.is-in, .call:not(.is-hidden), .chat__reply.is-in { opacity: 1; transform: none; }
.chat__prompt { align-self: flex-end; max-width: 86%; margin-bottom: 4px; text-align: right; }
.chat__author { display: block; margin-bottom: 4px; color: var(--home-ink-2); font-size: 11px; font-weight: 650; }
.chat__prompt p { margin: 0; padding: 9px 13px; border-radius: 14px 14px 4px 14px; color: var(--home-ink); background: var(--home-fill); font-size: 13px; line-height: 1.45; text-align: left; }
.chat__reply { margin: 6px 0 0; color: var(--home-ink); font-size: 13px; line-height: 1.5; }

.call { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 10px; padding: 9px 11px; border: 1px solid var(--home-edge); border-radius: 12px; background: var(--home-panel); }
.call.is-running { border-color: color-mix(in srgb, var(--ui-color-action) 45%, var(--home-edge)); }
.call__icon { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 8px; color: var(--ui-color-action); background: color-mix(in srgb, var(--ui-color-action) 12%, transparent); }
.call__main { display: grid; min-width: 0; gap: 2px; }
.call__head { display: flex; min-width: 0; align-items: center; gap: 8px; font-size: 12.5px; }
.call__head strong { overflow: hidden; color: var(--home-ink); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.call__target { display: inline-flex; flex: none; align-items: center; gap: 4px; color: var(--home-ink-2); font-size: 11px; }
.call__tool { overflow: hidden; color: var(--home-ink-2); font-family: var(--vp-font-family-mono); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.call__result { color: var(--home-ink-2); font-size: 12px; }
.call.is-done .call__result { color: var(--home-ink); }
.call__bar { display: block; height: 4px; margin: 6px 0 4px; overflow: hidden; border-radius: 2px; background: var(--home-fill); }
.call__bar i { display: block; height: 100%; background: var(--ui-color-action); transform-origin: left; }
.call__state { display: grid; width: 18px; height: 26px; place-items: center; color: var(--ui-color-success); }
.call.is-running .call__state { color: var(--ui-color-action); }
.call__spinner { animation: relay-spin 0.9s linear infinite; }
.thumb { display: block; width: 132px; height: 82px; margin-top: 8px; overflow: hidden; border-radius: 6px; box-shadow: 0 0 0 1px var(--home-edge); background: linear-gradient(135deg, color-mix(in srgb, var(--ui-color-accent) 55%, var(--home-window)), color-mix(in srgb, var(--ui-color-accent-alt) 45%, var(--home-window))); opacity: 0; transform: scale(0.92); transform-origin: left top; transition: opacity 300ms ease, transform 420ms var(--home-ease); }
.thumb.is-in { opacity: 1; transform: none; }
.thumb__window { position: relative; display: grid; width: 58%; height: 56%; margin: 18% auto 0; padding: 6px; gap: 3px; align-content: start; border-radius: 3px; background: var(--home-window); }
.thumb__window i { width: 9px; height: 9px; border-radius: 2px; background: var(--ui-color-action); }
.thumb__window b { height: 3px; border-radius: 2px; background: var(--ui-color-border-strong); }
.thumb__window b + b { width: 70%; }
.thumb__window em { position: absolute; right: 5px; bottom: 5px; width: 16px; height: 6px; border-radius: 2px; background: var(--ui-color-action); }

/* Lane: requests travel out, results travel back. */
.lane { position: relative; z-index: 2; }
.lane__track { position: absolute; top: 50%; right: -1px; left: -1px; height: 0; border-top: 1.5px dashed var(--ui-color-border-strong); }
.lane__server { position: absolute; top: 50%; left: 50%; display: grid; width: 44px; height: 44px; place-items: center; border: 1px solid var(--home-edge); border-radius: 14px; color: var(--home-ink); background: var(--home-window); box-shadow: 0 10px 24px -12px var(--home-shadow); transform: translate(-50%, -50%); }
.lane__server small { position: absolute; top: calc(100% + 8px); left: 50%; color: var(--home-ink-2); font-size: 11px; font-weight: 600; white-space: nowrap; transform: translateX(-50%); }
.packet { position: absolute; top: 50%; left: calc(var(--at) * 100%); display: grid; place-items: center; transform: translate(-50%, -50%); }
.packet i { width: 10px; height: 10px; border-radius: 50%; background: var(--ui-color-action); box-shadow: 0 0 0 4px color-mix(in srgb, var(--ui-color-action) 22%, transparent), 0 0 18px var(--ui-color-action); }
.packet--back i { background: var(--ui-color-success); box-shadow: 0 0 0 4px color-mix(in srgb, var(--ui-color-success) 22%, transparent), 0 0 18px var(--ui-color-success); }
.packet code { position: absolute; bottom: calc(100% + 8px); padding: 2px 7px; border: 1px solid var(--home-edge); border-radius: 6px; color: var(--home-ink); background: var(--home-window); font-family: var(--vp-font-family-mono); font-size: 10.5px; white-space: nowrap; }

/* The target machine's desktop. */
.desktop { position: relative; flex: 1; min-height: 360px; overflow: hidden; background: radial-gradient(70% 90% at 15% 10%, color-mix(in srgb, var(--ui-color-accent) 45%, transparent), transparent 60%), radial-gradient(70% 80% at 90% 90%, color-mix(in srgb, var(--ui-color-accent-alt) 40%, transparent), transparent 60%), color-mix(in srgb, var(--ui-color-accent) 16%, var(--home-window)); }
.desktop__layer { position: absolute; inset: 0 0 34px; }
.desktop__file { position: absolute; top: calc(20% - 25px); left: calc(15% - 56px); display: grid; width: 112px; justify-items: center; gap: 5px; padding: 6px 4px; border-radius: 8px; opacity: 0; transform: scale(0.6); transition: opacity 300ms ease, transform 420ms var(--ui-ease-spring, var(--home-ease)), background 120ms ease; }
.desktop__file.is-in { opacity: 1; transform: none; }
.desktop__file.is-picked { background: color-mix(in srgb, white 22%, transparent); }
.desktop__file-icon { display: grid; width: 38px; height: 38px; place-items: center; border-radius: 9px; background: var(--home-window); box-shadow: 0 6px 14px -6px var(--home-shadow); }
.desktop__file-icon img { width: 24px; height: 24px; border-radius: 5px; }
.desktop__file-name { color: var(--home-ink); font-size: 10.5px; font-weight: 600; text-align: center; white-space: nowrap; }
.installer { position: absolute; top: 50%; left: 56%; width: min(300px, 64%); overflow: hidden; border: 1px solid var(--home-edge); border-radius: 10px; background: var(--home-window); box-shadow: 0 24px 50px -18px rgb(0 0 0 / 50%); opacity: 0; transform: translate(-50%, -46%) scale(0.92); transition: opacity 260ms ease, transform 420ms var(--home-ease); }
.installer.is-in { opacity: 1; transform: translate(-50%, -50%); }
.installer__bar { display: flex; align-items: center; justify-content: space-between; padding: 7px 10px; border-bottom: 1px solid var(--home-edge); color: var(--home-ink-2); background: var(--ui-color-sidebar); font-size: 11px; font-weight: 600; }
.installer__controls { display: flex; gap: 8px; }
.installer__controls i { width: 8px; height: 8px; border: 1.5px solid var(--ui-color-border-strong); border-radius: 2px; }
.installer__body { display: flex; gap: 12px; padding: 14px 14px 10px; }
.installer__body img { width: 34px; height: 34px; flex: none; border-radius: 8px; }
.installer__body strong { display: block; color: var(--home-ink); font-size: 14px; font-weight: 700; }
.installer__body p { margin: 4px 0 0; color: var(--home-ink-2); font-size: 11.5px; line-height: 1.45; }
.installer__foot { display: flex; justify-content: flex-end; padding: 0 14px 12px; }
.installer__foot span { padding: 4px 14px; border-radius: 6px; color: var(--ui-color-action-text); background: var(--ui-color-action); font-size: 11px; font-weight: 650; }
.desktop__cursor { position: absolute; z-index: 3; margin: -2px 0 0 -2px; filter: drop-shadow(0 2px 3px rgb(0 0 0 / 45%)); }
.desktop__cursor path { fill: white; stroke: #111; stroke-width: 1.1; stroke-linejoin: round; }
.desktop__ripple { position: absolute; z-index: 2; top: 20%; left: 15%; width: 34px; height: 34px; margin: -17px 0 0 -17px; border: 2px solid white; border-radius: 50%; opacity: 0; transform: scale(0.3); }
.desktop__ripple.is-on { animation: relay-ripple 0.6s ease-out; }
.desktop__flash { position: absolute; z-index: 4; inset: 0; background: white; pointer-events: none; }
.desktop__toast { position: absolute; z-index: 5; top: 12px; right: 12px; display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; color: var(--home-ink); background: var(--home-window); box-shadow: 0 8px 20px -10px var(--home-shadow); font-size: 11px; font-weight: 650; opacity: 0; transform: translateY(-6px); transition: opacity 240ms ease, transform 320ms var(--home-ease); }
.desktop__toast.is-in { opacity: 1; transform: none; }
.desktop__taskbar { position: absolute; right: 0; bottom: 0; left: 0; display: flex; height: 34px; align-items: center; justify-content: center; gap: 8px; border-top: 1px solid color-mix(in srgb, white 14%, transparent); background: color-mix(in srgb, var(--home-window) 72%, transparent); backdrop-filter: blur(12px); }
.desktop__taskbar i { width: 18px; height: 18px; border-radius: 5px; background: color-mix(in srgb, var(--home-ink) 18%, transparent); }
.desktop__taskbar i:first-child { background: var(--ui-color-action); }

/* Four capabilities, each readable without the animation. */
.relay__features { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 28px; margin: clamp(32px, 4vw, 44px) 0 0; padding: 0; list-style: none; }
.relay__feature-icon { display: grid; width: 36px; height: 36px; margin-bottom: 14px; place-items: center; border-radius: 10px; color: var(--home-ink); background: var(--home-fill); }
.relay__features h3 { margin: 0 0 6px; color: var(--home-ink); font-size: 16px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; text-wrap: balance; }
.relay__features p { margin: 0; color: var(--home-ink-2); font-size: 14px; line-height: 1.55; text-wrap: pretty; }
.relay__link { color: var(--ui-color-action); font-family: var(--vp-font-family-mono); font-size: 0.92em; text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); text-underline-offset: 3px; transition: text-decoration-color 160ms ease; }
.relay__link:hover { text-decoration-color: currentColor; }

@keyframes relay-spin { to { transform: rotate(360deg); } }
@keyframes relay-ripple {
  0% { opacity: 0.9; transform: scale(0.3); }
  100% { opacity: 0; transform: scale(1.6); }
}

@media (max-width: 960px) {
  .relay__intro { grid-template-columns: 1fr; }
  .relay__features { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
/* Stacked scene: the lane runs vertically between the two machines. */
@media (max-width: 860px) {
  .relay__scene { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 120px auto; }
  .chat { min-height: 0; }
  .lane__track { top: -1px; bottom: -1px; left: 50%; right: auto; height: auto; border-top: 0; border-left: 1.5px dashed var(--ui-color-border-strong); }
  .lane__server small { top: 50%; left: calc(100% + 10px); transform: translateY(-50%); }
  .packet { top: calc(var(--at) * 100%); left: 50%; }
  .packet code { bottom: auto; right: calc(100% + 10px); }
  .desktop { min-height: 300px; }
}
@media (max-width: 560px) {
  .relay { width: calc(100% - 32px); }
  .relay__scene { padding: 12px; border-radius: 18px; }
  .relay__features { grid-template-columns: 1fr; gap: 22px; }
  .installer { width: 76%; left: 58%; }
  .desktop__file { left: 4%; }
}

.is-reduced .chat__prompt, .is-reduced .call, .is-reduced .chat__reply, .is-reduced .thumb, .is-reduced .desktop__file, .is-reduced .installer, .is-reduced .desktop__toast { transition: none; }
.is-reduced .call__spinner { animation: none; }
</style>
