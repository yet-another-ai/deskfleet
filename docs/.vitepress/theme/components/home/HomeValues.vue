<script setup lang="ts">
import { computed, ref } from "vue"
import { withBase } from "vitepress"
import { Code, Server, ShieldCheck, Monitor } from "@lucide/vue"
import { useRevealOnce } from "./home-motion.ts"
const props = withDefaults(defineProps<{ chinese?: boolean }>(), { chinese: false })
const root = ref<HTMLElement>()
const shown = useRevealOnce(root, 0.15)
const icons = [Code, Server, Monitor, ShieldCheck]
const values = computed(() => props.chinese ? [
  { title: "客户端完全开源", body: "你每天使用的界面、连接与交互，都有公开的源码。", link: "查看客户端", href: "https://github.com/yet-another-ai/deskfleet/tree/main/apps/desktop" },
  { title: "服务端也完全开源", body: "从前端到后端，完整实现均以 Apache-2.0 协议开放。", link: "查看服务端", href: "https://github.com/yet-another-ai/deskfleet/tree/main/apps/server" },
  { title: "在你的机器上工作", body: "复用你的开发环境和工具。Agent 的登录凭证保留在执行机器上。", link: "了解工作方式", href: withBase("/zh/guide/agents") },
  { title: "工作数据不用于训练", body: "DeskFleet 官方服务不会使用你的代码、对话和工作记录训练模型。", link: "阅读数据承诺", href: withBase("/zh/privacy") },
] : [
  { title: "An open-source client", body: "The interface, connections, and interactions you use every day. All there to inspect.", link: "Explore the client", href: "https://github.com/yet-another-ai/deskfleet/tree/main/apps/desktop" },
  { title: "An open-source server, too", body: "The complete implementation, frontend to backend, released under Apache-2.0.", link: "Explore the server", href: "https://github.com/yet-another-ai/deskfleet/tree/main/apps/server" },
  { title: "Your machines. Your environment.", body: "Keep your development environment and tools. Agent credentials stay on the machine doing the work.", link: "See how it works", href: withBase("/guide/agents") },
  { title: "Your work isn't training data", body: "The official DeskFleet service will not use your code, conversations, or work records to train models.", link: "Read our data promise", href: withBase("/privacy") },
])
</script>

<template>
  <section id="open" ref="root" class="values reveal" :class="{ 'is-shown': shown }">
    <header class="values__intro">
      <p class="home-kicker reveal-line" style="--line: 0">{{ chinese ? '信任，有据可查' : 'Trust you can inspect' }}</p>
      <h2 class="values__title reveal-line" style="--line: 1">{{ chinese ? '完全开源。安心工作。' : 'Fully open. Yours to trust.' }}</h2>
      <p class="values__subtitle reveal-line" style="--line: 2">{{ chinese ? '源码公开，数据使用承诺明确。' : 'Open code. A clear promise about your data.' }}</p>
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
