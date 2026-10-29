<script setup lang="ts">
import { Check, Copy, Download, Search, X } from "@lucide/vue"
import { useTimeoutFn } from "@vueuse/core"
import type { Terminal } from "@xterm/xterm"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui"
import { computed, onBeforeUnmount, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import TerminalSearch from "./TerminalSearch.vue"
import { useTerminalAddons } from "./useTerminalAddons.ts"

const props = defineProps<{ terminal: Terminal; interactive: boolean }>()
const { t } = useI18n()
const search = useTemplateRef<InstanceType<typeof TerminalSearch>>("search")
const { progress, pendingClipboard, serialize, reset: resetAddons } = useTerminalAddons(props.terminal, () => props.interactive)
const isSupported = typeof navigator.clipboard?.writeText === "function"
const copied = ref(false)
const { start: scheduleCopiedReset, stop: cancelCopiedReset } = useTimeoutFn(() => { copied.value = false }, 1500, { immediate: false })
const hasSelection = ref(false)
const selection = props.terminal.onSelectionChange(() => { hasSelection.value = props.terminal.hasSelection() })
const error = ref(false)
const menuOpen = ref(false)
let downloadUrl: string | undefined
const progressLabel = computed(() => {
  switch (progress.value.state) {
    case 1: return t("terminal.progressRunning", { value: progress.value.value })
    case 2: return t("terminal.progressError", { value: progress.value.value })
    case 3: return t("terminal.progressIndeterminate")
    case 4: return t("terminal.progressPaused", { value: progress.value.value })
    default: return ""
  }
})

async function copyText(value: string, requested = false): Promise<void> {
  cancelCopiedReset()
  copied.value = false
  error.value = false
  try {
    // Preserve write failures so the user can retry a requested copy.
    await navigator.clipboard.writeText(value)
    copied.value = true
    scheduleCopiedReset()
    if (requested && pendingClipboard.value === value) pendingClipboard.value = null
  } catch { error.value = true }
}

function download(format: "ansi" | "html"): void {
  const content = serialize(format)
  if (downloadUrl) URL.revokeObjectURL(downloadUrl)
  downloadUrl = URL.createObjectURL(new Blob([content], { type: format === "html" ? "text/html;charset=utf-8" : "text/plain;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = downloadUrl
  link.download = `terminal-${new Date().toISOString().replaceAll(":", "-")}.${format === "html" ? "html" : "ans"}`
  link.click()
  menuOpen.value = false
}

function reset(): void {
  resetAddons()
  search.value?.reset()
  error.value = false
  copied.value = false
  cancelCopiedReset()
  hasSelection.value = false
}
onBeforeUnmount(() => {
  selection.dispose()
  if (downloadUrl) URL.revokeObjectURL(downloadUrl)
})
defineExpose({ openSearch: () => search.value?.open(), searchOpen: computed(() => search.value?.isOpen ?? false), reset })
</script>

<template>
  <TerminalSearch ref="search" :terminal="terminal" class="absolute right-2 top-2 z-10" style="max-width: calc(100% - 1rem)" />
  <div v-if="pendingClipboard !== null" class="flex min-w-0 shrink-0 items-center gap-2 border-t border-ui-border bg-ui-surface px-2 py-1 text-xs text-ui-text" role="status">
    <span class="shrink-0">{{ t('terminal.clipboardRequest') }}</span>
    <span class="min-w-0 flex-1 truncate font-mono" :title="pendingClipboard">{{ pendingClipboard }}</span>
    <button type="button" class="ui-button h-6 shrink-0 px-2 text-xs" :disabled="!isSupported" @click="copyText(pendingClipboard!, true)">{{ t('terminal.copyRequested') }}</button>
    <button type="button" class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-ui-hover" :aria-label="t('terminal.dismissClipboard')" @click="pendingClipboard = null"><X :size="13" aria-hidden="true" /></button>
  </div>
  <div class="flex h-7 min-w-0 shrink-0 items-center gap-1 border-t border-ui-border bg-ui-surface px-1.5 text-ui-text-muted" data-terminal-toolbar>
    <div class="flex min-w-0 flex-1 items-center gap-2 px-1 text-[11px]">
      <template v-if="progress.state !== 0">
        <div
          role="progressbar"
          :aria-label="progressLabel"
          :aria-valuenow="progress.state === 3 ? undefined : progress.value"
          :aria-valuemin="0"
          :aria-valuemax="100"
          class="h-1 w-16 shrink-0 overflow-hidden rounded bg-ui-hover"
        ><div
          class="h-full rounded"
          :class="[progress.state === 2 ? 'bg-ui-danger' : progress.state === 4 ? 'bg-ui-warning' : 'bg-ui-accent', progress.state === 3 && 'animate-pulse']"
          :style="{ width: progress.state === 3 ? '100%' : `${progress.value}%` }"
        /></div>
        <span class="truncate" :title="progressLabel">{{ progressLabel }}</span>
      </template>
      <span v-if="error" role="alert" class="truncate text-ui-danger">{{ t('terminal.copyFailed') }}</span>
    </div>
    <button type="button" class="inline-flex h-6 w-7 shrink-0 items-center justify-center rounded hover:bg-ui-hover hover:text-ui-text" :aria-label="t('terminal.searchLabel')" :title="t('terminal.searchShortcut')" @click="search?.open()"><Search :size="14" aria-hidden="true" /></button>
    <button type="button" class="inline-flex h-6 w-7 shrink-0 items-center justify-center rounded hover:bg-ui-hover hover:text-ui-text disabled:opacity-40" :aria-label="t('terminal.copySelection')" :title="t('terminal.copySelection')" :disabled="!hasSelection || !isSupported" @click="copyText(terminal.getSelection())"><component :is="copied ? Check : Copy" :size="14" aria-hidden="true" /></button>
    <DropdownMenuRoot :open="menuOpen" :modal="false" @update:open="menuOpen = $event">
      <DropdownMenuTrigger class="inline-flex h-6 w-7 shrink-0 items-center justify-center rounded hover:bg-ui-hover hover:text-ui-text" :aria-label="t('terminal.exportBuffer')" :title="t('terminal.exportBuffer')"><Download :size="14" aria-hidden="true" /></DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent align="end" side="top" :side-offset="4" class="ui-menu z-50 min-w-48">
          <DropdownMenuItem as="button" type="button" class="ui-menu-item" @select="download('ansi')">{{ t('terminal.exportAnsi') }}</DropdownMenuItem>
          <DropdownMenuItem as="button" type="button" class="ui-menu-item" @select="download('html')">{{ t('terminal.exportHtml') }}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>
