<script setup lang="ts">
import type { AppLocale } from "@deskfleet/client/i18n"
import { useDocumentVisibility, useElementVisibility, usePreferredReducedMotion, useResizeObserver } from "@vueuse/core"
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useData } from "vitepress"
import { networkCopy } from "./network-locales.ts"
import type { createRelayGlobe } from "./relay-globe.ts"

const props = defineProps<{ locale: AppLocale }>()
const root = ref<HTMLElement>()
const canvas = ref<HTMLElement>()
const { isDark } = useData()
const nearby = useElementVisibility(root, { rootMargin: "240px", once: true })
const visible = useElementVisibility(root)
const documentVisibility = useDocumentVisibility()
const preferredMotion = usePreferredReducedMotion()
const moving = computed(() => visible.value && documentVisibility.value === "visible" && preferredMotion.value !== "reduce")
const t = computed(() => networkCopy[props.locale])
const status = ref<"loading" | "ready" | "unavailable">("loading")
let globe: ReturnType<typeof createRelayGlobe> | undefined
let disposed = false

watch(nearby, async () => {
  try {
    // ECharts GL touches browser globals; keep it out of SSR and the initial page load.
    const { createRelayGlobe } = await import("./relay-globe.ts")
    if (disposed || !canvas.value) return
    globe = createRelayGlobe(canvas.value, t.value, moving.value)
    status.value = "ready"
  } catch {
    if (!disposed) status.value = "unavailable"
  }
}, { once: true })

watch(moving, enabled => globe?.setMotion(enabled))
watch(t, labels => globe?.setLabels(labels))
watch(isDark, () => globe?.setTheme(), { flush: "post" })
useResizeObserver(root, () => globe?.resize())
onBeforeUnmount(() => {
  disposed = true
  globe?.dispose()
})
</script>

<template>
  <div ref="root" class="relay-globe" role="img" :aria-label="t.globeLabel" :aria-busy="status === 'loading'">
    <div ref="canvas" class="relay-globe__canvas" aria-hidden="true" />
    <div v-if="status !== 'ready'" class="relay-globe__placeholder">
      <div class="relay-globe__sphere" aria-hidden="true" />
      <p role="status">{{ status === 'loading' ? t.loading : t.unavailable }}</p>
    </div>
  </div>
</template>

<style scoped>
.relay-globe { position: relative; width: 100%; height: 100%; overflow: hidden; }
.relay-globe__canvas { width: 100%; height: 100%; cursor: grab; }
.relay-globe__canvas:active { cursor: grabbing; }
.relay-globe__placeholder { position: absolute; inset: 0; display: grid; align-content: center; justify-items: center; gap: 20px; padding: 32px; }
.relay-globe__sphere { width: min(68%, 340px); aspect-ratio: 1; border: 1px solid var(--home-edge); border-radius: 50%; background: radial-gradient(circle at 35% 30%, var(--home-panel), var(--home-window)); }
.relay-globe__placeholder p { max-width: 300px; margin: 0; color: var(--home-ink-2); font-size: 12px; text-align: center; }
</style>
