<script setup lang="ts">
import type { AppLocale } from "@deskfleet/client/i18n"
import { computed, ref } from "vue"
import RelayGlobe from "./RelayGlobe.vue"
import { useRevealOnce } from "./home-motion.ts"
import { networkCopy } from "./network-locales.ts"

const props = withDefaults(defineProps<{ locale?: AppLocale }>(), { locale: "en-US" })
const root = ref<HTMLElement>()
const shown = useRevealOnce(root, 0.1)
const t = computed(() => networkCopy[props.locale])
</script>

<template>
  <section id="network" ref="root" class="network reveal" :class="{ 'is-shown': shown }" aria-labelledby="network-title">
    <header class="network__intro">
      <h2 id="network-title" class="network__title reveal-line" style="--line: 0">{{ t.title }}</h2>
      <p class="network__lead reveal-line" style="--line: 1">{{ t.lead }}</p>
    </header>
    <div class="network__visual reveal-line" style="--line: 2">
      <div class="network__stage"><RelayGlobe :locale="locale" /></div>
    </div>
  </section>
</template>

<style scoped>
.network { width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: clamp(96px, 12vw, 156px) 0 0; }
.network__intro { text-align: center; }
.network__title { margin: 0; color: var(--home-ink); font-size: clamp(36px, 5vw, 60px); font-weight: 780; letter-spacing: -0.045em; line-height: 1.08; text-wrap: balance; word-break: auto-phrase; }
.network__lead { margin: 18px auto 0; color: var(--home-ink-2); font-size: 17px; line-height: 1.6; text-wrap: balance; }
.network__visual { max-width: 960px; min-width: 0; margin: 16px auto 0; }
.network__stage { width: 100%; height: clamp(380px, 48vw, 560px); min-width: 0; }
@media (max-width: 560px) {
  .network { width: calc(100% - 32px); }
  .network__lead { max-width: 330px; margin-top: 14px; font-size: 15px; }
  .network__visual { margin-top: 8px; }
  .network__stage { height: clamp(320px, 92vw, 400px); }
}
</style>
