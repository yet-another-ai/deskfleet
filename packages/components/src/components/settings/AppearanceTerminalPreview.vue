<script setup lang="ts">
import { Terminal as TerminalIcon } from "@lucide/vue"
import type { TerminalColors } from "@deskfleet/client/terminal-theme"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useAppearanceStore } from "../../stores/appearance.ts"
import TerminalSurface from "../terminal/TerminalSurface.vue"

const props = defineProps<{ fontFamily: string; ligatures: boolean; theme?: TerminalColors }>()
const appearance = useAppearanceStore()
const colors = computed(() => props.theme ?? appearance.terminalTheme)
const { t } = useI18n()
const sample = [
  '\x1b[34m~/deskfleet\x1b[0m \x1b[2mon main\x1b[0m',
  '\x1b[32m❯\x1b[0m echo "Hello, world! 你好，世界。"',
  'Hello, world! 你好，世界。',
  '\x1b[31mred  \x1b[32mgreen  \x1b[33myellow  \x1b[34mblue  \x1b[35mmagenta  \x1b[36mcyan\x1b[0m',
  '\x1b[2m0123456789  {} [] ()\x1b[0m',
  '\x1b[94m=>  ->  ===  !==  !=  <=  >=  &&  ||\x1b[0m',
].join('\n')
</script>

<template>
  <div
    data-terminal-font-preview class="overflow-hidden rounded-xl border"
    :style="{ backgroundColor: colors.background, color: colors.foreground, borderColor: colors.selectionBackground }"
    :aria-label="t('appearance.terminalPreview')"
  >
    <div class="flex h-9 items-center gap-2 border-b px-3.5 text-xs" :style="{ borderColor: colors.selectionBackground }">
      <TerminalIcon :size="13" :stroke-width="1.75" aria-hidden="true" />
      <span>Terminal</span>
      <span class="ml-auto text-[11px] opacity-70">{{ t("appearance.preview") }}</span>
    </div>
    <div class="h-36">
      <TerminalSurface :font-family="fontFamily" :ligatures="ligatures" :theme="colors" :banner="sample" :scrollback="0" />
    </div>
  </div>
</template>
