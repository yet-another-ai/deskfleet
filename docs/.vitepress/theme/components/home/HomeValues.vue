<script setup lang="ts">
import type { AppLocale } from "@deskfleet/client/i18n"
import { computed, ref } from "vue"
import { withBase } from "vitepress"
import { Ban, Code, FolderGit2, KeyRound, Laptop, LockKeyhole, ShieldCheck, Wrench } from "@lucide/vue"
import { useRevealOnce } from "./home-motion.ts"
import { homeCopy, homeLocalePath } from "./home-locales.ts"

const props = withDefaults(defineProps<{ locale?: AppLocale }>(), { locale: "en-US" })
const root = ref<HTMLElement>()
const shown = useRevealOnce(root, 0.15)
const t = computed(() => homeCopy[props.locale].values)

const repository = "https://github.com/yet-another-ai/deskfleet"
const tree = computed(() => {
  const labels = t.value.source.tree
  return [
    { path: "apps/desktop", label: labels.desktop },
    { path: "apps/web", label: labels.web },
    { path: "apps/daemon", label: labels.daemon },
    { path: "apps/server", label: labels.server },
    { path: "crates", label: labels.crates },
  ].map((row, index, rows) => ({ ...row, href: `${repository}/tree/main/${row.path}`, branch: index === rows.length - 1 ? "└─" : "├─" }))
})
const machineIcons = [FolderGit2, Wrench, KeyRound]
const guide = computed(() => withBase(homeLocalePath(props.locale, "/guide/agents")))
const privacy = computed(() => withBase(homeLocalePath(props.locale, "/privacy")))
</script>

<template>
  <section id="open" ref="root" class="values reveal" :class="{ 'is-shown': shown }">
    <header class="values__intro">
      <p class="home-kicker reveal-line" style="--line: 0">{{ t.kicker }}</p>
      <h2 class="values__title reveal-line" style="--line: 1">{{ t.title }}</h2>
      <p class="values__subtitle reveal-line" style="--line: 2">{{ t.subtitle }}</p>
    </header>

    <div class="values__grid">
      <article class="values__card values__card--source reveal-line" style="--line: 3">
        <div class="values__copy">
          <div class="values__head">
            <span class="values__icon"><Code :size="20" :stroke-width="1.9" aria-hidden="true" /></span>
            <span class="values__license">Apache-2.0</span>
          </div>
          <h3>{{ t.source.title }}</h3>
          <p>{{ t.source.body }}</p>
          <a class="values__link" :href="repository">{{ t.source.link }} <span aria-hidden="true">→</span></a>
        </div>
        <div class="repo">
          <a class="repo__name" :href="repository">yet-another-ai/deskfleet</a>
          <ul class="repo__tree">
            <li v-for="row in tree" :key="row.path">
              <a :href="row.href">
                <span class="repo__branch" aria-hidden="true">{{ row.branch }}</span>
                <span class="repo__path">{{ row.path }}</span>
                <span class="repo__label">{{ row.label }}</span>
              </a>
            </li>
          </ul>
        </div>
      </article>

      <article class="values__card reveal-line" style="--line: 4">
        <div class="values__head">
          <span class="values__icon"><Laptop :size="20" :stroke-width="1.9" aria-hidden="true" /></span>
        </div>
        <h3>{{ t.machines.title }}</h3>
        <p>{{ t.machines.body }}</p>
        <div class="machine">
          <div class="machine__bar"><i aria-hidden="true" />Studio Mac</div>
          <ul class="machine__rows">
            <li v-for="(row, i) in t.machines.rows" :key="row" :class="{ 'is-key': i === machineIcons.length - 1 }">
              <component :is="machineIcons[i]" :size="15" :stroke-width="1.9" aria-hidden="true" />
              <span>{{ row }}</span>
              <span v-if="i === machineIcons.length - 1" class="machine__badge"><LockKeyhole :size="12" :stroke-width="2.2" aria-hidden="true" />{{ t.machines.badge }}</span>
            </li>
          </ul>
        </div>
        <a class="values__link" :href="guide">{{ t.machines.link }} <span aria-hidden="true">→</span></a>
      </article>

      <article class="values__card reveal-line" style="--line: 5">
        <div class="values__head">
          <span class="values__icon"><ShieldCheck :size="20" :stroke-width="1.9" aria-hidden="true" /></span>
        </div>
        <h3>{{ t.data.title }}</h3>
        <p>{{ t.data.body }}</p>
        <div class="promise" aria-hidden="true">
          <span class="promise__inputs"><span v-for="item in t.data.inputs" :key="item" class="promise__chip">{{ item }}</span></span>
          <span class="promise__gap"><Ban :size="16" :stroke-width="2.2" /></span>
          <span class="promise__chip promise__chip--blocked">{{ t.data.output }}</span>
        </div>
        <a class="values__link" :href="privacy">{{ t.data.link }} <span aria-hidden="true">→</span></a>
      </article>
    </div>
  </section>
</template>

<style scoped>
.values { width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: clamp(110px, 14vw, 180px) 0 40px; }
.values__intro { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 0.8fr); align-items: end; gap: 12px 48px; margin-bottom: clamp(32px, 4vw, 48px); }
.values__intro .home-kicker { grid-column: 1 / -1; margin: 0; }
.values__title { margin: 0; font-size: clamp(36px, 5vw, 60px); font-weight: 780; letter-spacing: -0.045em; line-height: 1.04; text-wrap: balance; word-break: auto-phrase; }
.values__subtitle { margin: 0 0 6px; color: var(--home-ink-2); font-size: clamp(17px, 1.6vw, 20px); font-weight: 550; line-height: 1.45; text-wrap: balance; }

/* Bento: open source spans the top; the two promises sit side by side below. */
.values__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.values__card { position: relative; display: flex; flex-direction: column; align-items: flex-start; padding: 26px 28px 28px; overflow: hidden; border: 1px solid var(--home-edge); border-radius: 24px; background: var(--home-panel); }
.values__card--source { display: grid; grid-column: 1 / -1; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1fr); align-items: center; gap: 28px 56px; padding: 32px; background: radial-gradient(120% 70% at 0% 0%, color-mix(in srgb, var(--ui-color-action) 12%, transparent), transparent 60%), var(--home-panel); }
.values__head { display: flex; width: 100%; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.values__icon { display: grid; width: 38px; height: 38px; place-items: center; border-radius: 11px; color: var(--home-ink); background: var(--home-fill); }
.values__card--source .values__icon { color: var(--ui-color-action-text); background: var(--ui-color-action); }
.values__license { padding: 4px 10px; border: 1px solid var(--home-edge); border-radius: 999px; color: var(--home-ink-2); font-family: var(--vp-font-family-mono); font-size: 12px; }
.values__card h3 { margin: 0 0 10px; font-size: 21px; font-weight: 730; letter-spacing: -0.02em; line-height: 1.25; text-wrap: balance; word-break: auto-phrase; }
.values__card--source h3 { font-size: clamp(26px, 3vw, 36px); letter-spacing: -0.03em; line-height: 1.15; }
.values__copy { display: flex; flex-direction: column; align-items: flex-start; }
.values__card > p, .values__copy > p { max-width: 520px; margin: 0; color: var(--home-ink-2); font-size: 15px; line-height: 1.6; text-wrap: pretty; }
.values__link { margin-top: auto; padding-top: 22px; font-size: 13px; font-weight: 650; }
.values__link span { display: inline-block; color: var(--ui-color-text-muted); transition: transform 160ms ease; }
.values__link:hover { text-decoration: underline; text-underline-offset: 4px; }
.values__link:hover span { transform: translateX(3px); }

/* The real repository layout, each row linking to its source. */
.repo { width: 100%; }
.repo__name { display: block; padding: 12px 16px; border: 1px solid var(--home-edge); border-bottom: 0; border-radius: 14px 14px 0 0; color: var(--home-ink); background: var(--ui-color-sidebar); font-family: var(--vp-font-family-mono); font-size: 13px; font-weight: 600; }
.repo__tree { margin: 0; padding: 8px; border: 1px solid var(--home-edge); border-radius: 0 0 14px 14px; background: var(--home-window); list-style: none; }
.repo__tree a { display: flex; align-items: baseline; gap: 10px; padding: 8px 10px; border-radius: 8px; transition: background 160ms ease; }
.repo__tree a:hover { background: var(--home-fill); }
.repo__branch { color: var(--ui-color-text-faint); font-family: var(--vp-font-family-mono); font-size: 13px; }
.repo__path { color: var(--home-ink); font-family: var(--vp-font-family-mono); font-size: 13px; }
.repo__label { margin-left: auto; color: var(--home-ink-2); font-size: 13px; text-align: right; }

/* A machine holding what never leaves it. */
.machine { width: 100%; margin-top: 22px; border: 1px solid var(--home-edge); border-radius: 14px; background: var(--home-window); }
.machine__bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--home-edge); font-size: 13px; font-weight: 650; }
.machine__bar i { width: 7px; height: 7px; border-radius: 50%; background: var(--ui-color-success); }
.machine__badge { display: inline-flex; margin-left: auto; white-space: nowrap; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; color: var(--ui-color-success); background: color-mix(in srgb, var(--ui-color-success) 12%, transparent); font-size: 11px; font-weight: 650; }
.machine__rows { display: grid; gap: 6px; margin: 0; padding: 10px; list-style: none; }
.machine__rows li { display: flex; align-items: center; gap: 9px; min-height: 36px; padding: 6px 10px; border: 1px solid transparent; border-radius: 9px; color: var(--home-ink-2); background: var(--home-fill); font-size: 13px; }
.machine__rows li svg { flex: none; }
.machine__rows li.is-key { border-color: color-mix(in srgb, var(--ui-color-success) 40%, var(--home-edge)); color: var(--home-ink); }
.machine__rows li.is-key svg { color: var(--ui-color-success); }

/* Your work, kept apart from model training. */
.promise { display: grid; width: 100%; grid-template-columns: auto minmax(40px, 1fr) auto; align-items: center; margin-top: 22px; padding: 10px; border: 1px solid var(--home-edge); border-radius: 14px; background: var(--home-window); }
.promise__inputs { display: grid; gap: 6px; }
.promise__chip { display: flex; min-height: 36px; align-items: center; padding: 6px 12px; border-radius: 9px; color: var(--home-ink); background: var(--home-fill); font-size: 13px; font-weight: 550; }
.promise__gap { position: relative; display: grid; height: 100%; place-items: center; color: var(--ui-color-danger); }
.promise__gap::before { position: absolute; z-index: 0; inset: 50% 8px auto; border-top: 1px dashed var(--ui-color-border-strong); content: ""; }
.promise__gap svg { position: relative; padding: 4px; border-radius: 50%; background: var(--home-window); box-sizing: content-box; }
.promise__chip--blocked { border: 1px dashed color-mix(in srgb, var(--ui-color-danger) 55%, var(--home-edge)); color: var(--ui-color-danger); background: transparent; text-decoration: line-through; text-decoration-thickness: 1.5px; }

@media (max-width: 960px) {
  .values__intro { grid-template-columns: 1fr; }
  .values__grid { grid-template-columns: 1fr; }
  .values__card--source { grid-template-columns: 1fr; padding: 26px 28px 28px; }
}
@media (max-width: 560px) {
  .values { width: calc(100% - 32px); }
  .values__card { padding: 22px 20px 24px; }
  .repo__label { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .values__link span, .repo__tree a { transition: none; }
}
</style>
