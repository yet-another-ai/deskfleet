<script setup lang="ts">
import type { AppLocale } from "@deskfleet/client/i18n"
import { computed, ref } from "vue"
import { withBase } from "vitepress"
import { Code, Server, ShieldCheck, Monitor } from "@lucide/vue"
import { useRevealOnce } from "./home-motion.ts"
import { homeCopy, homeLocalePath } from "./home-locales.ts"

const props = withDefaults(defineProps<{ locale?: AppLocale }>(), { locale: "en-US" })
const root = ref<HTMLElement>()
const shown = useRevealOnce(root, 0.15)
const icons = [Code, Server, Monitor, ShieldCheck]
const t = computed(() => homeCopy[props.locale].values)
const values = computed(() => {
  const links = [
    "https://github.com/yet-another-ai/deskfleet/tree/main/apps/desktop",
    "https://github.com/yet-another-ai/deskfleet/tree/main/apps/server",
    withBase(homeLocalePath(props.locale, "/guide/agents")),
    withBase(homeLocalePath(props.locale, "/privacy")),
  ]
  return t.value.cards.map((card, index) => ({ ...card, href: links[index] }))
})
</script>

<template>
  <section id="open" ref="root" class="values reveal" :class="{ 'is-shown': shown }">
    <header class="values__intro">
      <p class="home-kicker reveal-line" style="--line: 0">{{ t.kicker }}</p>
      <h2 class="values__title reveal-line" style="--line: 1">{{ t.title }}</h2>
      <p class="values__subtitle reveal-line" style="--line: 2">{{ t.subtitle }}</p>
    </header>
    <ul class="values__grid">
      <li v-for="(value, i) in values" :key="i" class="values__card reveal-line" :style="{ '--line': i + 3 }">
        <component :is="icons[i]" class="values__icon" :size="40" :stroke-width="1.8" aria-hidden="true" />
        <h3>{{ value.title }}</h3>
        <p>{{ value.body }}</p>
        <a :href="value.href">{{ value.link }} <span aria-hidden="true">→</span></a>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.values { width: min(1120px, calc(100% - 48px)); margin: 0 auto; padding: clamp(96px, 12vw, 150px) 0 40px; }
.values__intro { max-width: 1040px; margin: 0 auto 48px; text-align: center; }
.values__title { margin: 0 0 18px; font-size: clamp(38px, 6vw, 72px); font-weight: 760; letter-spacing: -0.045em; line-height: 1.08; text-wrap: balance; }
.values__subtitle { margin: 0; color: var(--home-ink-2); font-size: clamp(19px, 2vw, 24px); font-weight: 600; letter-spacing: -0.01em; text-wrap: balance; }
.values__grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 0; padding: 0; list-style: none; }
.values__card { display: flex; flex-direction: column; align-items: flex-start; padding: 24px 22px 26px; border: 1px solid var(--home-edge); border-radius: 22px; background: var(--home-panel); backdrop-filter: blur(18px); }
.values__icon { flex: none; margin-bottom: 18px; padding: 9px; border-radius: 12px; background: var(--ui-color-hover); color: var(--ui-color-text-muted); }
.values__card h3 { margin: 0 0 8px; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; }
.values__card p { margin: 0 0 22px; color: var(--home-ink-2); font-size: 14px; line-height: 1.6; }
.values__card a { margin-top: auto; font-size: 12px; font-weight: 650; }
.values__card a span { color: var(--ui-color-text-muted); }
.values__card a:hover { text-decoration: underline; text-underline-offset: 4px; }
@media (max-width: 960px) { .values__grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 560px) { .values { width: calc(100% - 32px); } .values__grid { grid-template-columns: 1fr; } }
</style>
