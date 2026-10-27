<script setup lang="ts">
import { Terminal as TerminalIcon } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import TerminalSurface from "../terminal/TerminalSurface.vue"

defineProps<{ fontFamily: string; ligatures: boolean }>()
const { t } = useI18n()
const sample = [
  '\x1b[38;2;142;155;255m~/deskfleet\x1b[0m \x1b[38;2;124;131;147mon main\x1b[0m',
  '\x1b[38;2;76;195;138m❯\x1b[0m echo "Hello, world! 你好，世界。"',
  'Hello, world! 你好，世界。',
  '',
  '\x1b[38;2;163;169;183m0123456789  {} [] ()\x1b[0m',
  '\x1b[38;2;142;155;255m=>  ->  ===  !==  !=  <=  >=  &&  ||\x1b[0m',
].join('\n')
</script>

<template>
  <div data-terminal-font-preview class="overflow-hidden rounded-xl border border-[#303440] bg-ui-terminal text-[#e3e6ee]" :aria-label="t('appearance.terminalPreview')">
    <div class="flex h-9 items-center gap-2 border-b border-[#ffffff]/7 bg-[#1b1e26] px-3.5 text-xs text-[#a3a9b7]">
      <TerminalIcon :size="13" :stroke-width="1.75" aria-hidden="true" />
      <span>Terminal</span>
      <span class="ml-auto text-[11px] text-[#7c8393]">{{ t("appearance.preview") }}</span>
    </div>
    <div class="h-34 px-4 py-3">
      <TerminalSurface :font-family="fontFamily" :ligatures="ligatures" :banner="sample" :scrollback="0" />
    </div>
  </div>
</template>
