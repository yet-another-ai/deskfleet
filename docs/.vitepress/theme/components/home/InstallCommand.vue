<script setup lang="ts">
import { Check, Copy, Terminal } from "@lucide/vue"
import { useClipboard } from "@vueuse/core"
import { ref } from "vue"

const props = defineProps<{
  title: string
  description: string
  command: string
  requirement: string
  href: string
  copy: { terminal: string; copyCommand: string; copied: string; copyFailed: string }
}>()
const { copy, copied, isSupported } = useClipboard({ source: () => props.command, legacy: true })
const failed = ref(false)

async function copyCommand() {
  failed.value = false
  try { await copy() } catch { failed.value = true }
}
</script>

<template>
  <div class="install-command">
    <div class="install-command__intro">
      <h3>{{ title }}</h3>
      <p>{{ description }}</p>
    </div>
    <div class="install-command__terminal">
      <div class="install-command__bar">
        <span><Terminal :size="15" aria-hidden="true" />{{ props.copy.terminal }}</span>
        <button v-if="isSupported" type="button" :aria-label="props.copy.copyCommand" @click="copyCommand">
          <Check v-if="copied" :size="15" aria-hidden="true" /><Copy v-else :size="15" aria-hidden="true" />
          <span aria-live="polite">{{ copied ? props.copy.copied : props.copy.copyCommand }}</span>
        </button>
      </div>
      <pre><span class="install-command__prompt" aria-hidden="true">$ </span><code>{{ command }}</code></pre>
    </div>
    <p v-if="failed" role="status" class="install-command__requirement">{{ props.copy.copyFailed }}</p>
    <a class="install-command__requirement" :href="href">{{ requirement }} ↗</a>
  </div>
</template>

<style scoped>
.install-command { padding: 24px; border: 1px solid var(--home-edge); border-radius: 20px; background: var(--home-window-solid); }
.install-command__intro h3 { margin: 0; color: var(--home-ink); font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
.install-command__intro p { margin: 8px 0 20px; color: var(--home-ink-2); font-size: 15px; line-height: 1.65; }
.install-command__terminal { overflow: hidden; border: 1px solid var(--home-edge); border-radius: 12px; background: var(--home-fill); }
.install-command__bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--home-edge); color: var(--home-ink-2); font-size: 12px; font-weight: 600; }
.install-command__bar > span, .install-command__bar button { display: inline-flex; align-items: center; gap: 7px; }
.install-command__bar button { min-height: 28px; padding: 3px 7px; border-radius: 6px; cursor: pointer; }
.install-command__bar button:hover { background: var(--home-edge); color: var(--home-ink); }
.install-command__bar button:focus-visible { outline: 2px solid var(--ui-color-focus); outline-offset: 2px; }
.install-command pre { margin: 0; padding: 18px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--home-ink); font-family: var(--vp-font-family-mono); font-size: 13px; line-height: 1.8; }
.install-command code { font-family: inherit; }
.install-command__prompt { color: var(--home-ink-2); user-select: none; }
.install-command__requirement { display: block; margin: 14px 0 0; color: var(--home-ink-2); font-size: 13px; line-height: 1.6; }
a.install-command__requirement:hover { color: var(--home-ink); text-decoration: underline; text-underline-offset: 3px; }
@media (max-width: 560px) { .install-command { padding: 18px; } .install-command pre { padding: 14px; } }
</style>
