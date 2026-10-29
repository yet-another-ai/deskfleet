<script setup lang="ts">
import { ArrowDown, ArrowUp, CaseSensitive, Regex, WholeWord, X } from "@lucide/vue"
import { useDebounceFn, useFocus } from "@vueuse/core"
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from "@xterm/addon-search"
import type { IDisposable, Terminal } from "@xterm/xterm"
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"

const props = defineProps<{ terminal: Terminal }>()
const { t } = useI18n()
const input = useTemplateRef<HTMLInputElement>("input")
const { focused } = useFocus(input, { preventScroll: true })
const isOpen = ref(false)
const query = ref("")
const caseSensitive = ref(false)
const wholeWord = ref(false)
const regex = ref(false)
const results = ref<ISearchResultChangeEvent>({ resultIndex: -1, resultCount: 0 })
let addon: SearchAddon | undefined
let subscription: IDisposable | undefined

const invalidRegex = computed(() => {
  if (!regex.value || !query.value) return false
  try { new RegExp(query.value); return false }
  catch { return true }
})
const resultLabel = computed(() => {
  if (invalidRegex.value) return t("terminal.searchInvalidRegex")
  if (!query.value) return ""
  if (!results.value.resultCount) return t("terminal.searchNoResults")
  if (results.value.resultIndex < 0) return t("terminal.searchManyResults", { count: results.value.resultCount })
  return t("terminal.searchResults", { index: results.value.resultIndex + 1, count: results.value.resultCount })
})

function clear(): void {
  addon?.clearDecorations()
  if (addon) props.terminal.clearSelection()
  results.value = { resultIndex: -1, resultCount: 0 }
}

function find(previous = false, incremental = false): void {
  delayedFind.cancel()
  if (!isOpen.value || !addon) return
  if (!query.value || invalidRegex.value) { clear(); return }
  const options: ISearchOptions = {
    caseSensitive: caseSensitive.value,
    wholeWord: wholeWord.value,
    regex: regex.value,
    incremental,
    // The terminal remains dark in both application themes.
    decorations: {
      matchBackground: "#725c35",
      matchOverviewRuler: "#e5b567",
      activeMatchBackground: "#3d4e78",
      activeMatchBorder: "#99a7ff",
      activeMatchColorOverviewRuler: "#99a7ff",
    },
  }
  if (previous) addon.findPrevious(query.value, options)
  else addon.findNext(query.value, options)
}

const delayedFind = useDebounceFn(() => find(false, true), 120)
function scheduleFind(): void {
  delayedFind.cancel()
  if (!isOpen.value) return
  if (!query.value || invalidRegex.value) clear()
  else void delayedFind()
}
watch(query, scheduleFind)
watch([caseSensitive, wholeWord, regex], () => {
  // SearchAddon 0.16.0 does not invalidate cached highlights when only options change.
  addon?.clearDecorations()
  scheduleFind()
})

async function open(): Promise<void> {
  if (!addon) {
    addon = new SearchAddon()
    props.terminal.loadAddon(addon)
    subscription = addon.onDidChangeResults(value => { results.value = value })
  }
  const selection = props.terminal.getSelection()
  if (selection && !/[\r\n]/.test(selection)) query.value = selection
  isOpen.value = true
  await nextTick()
  focused.value = true
  input.value?.select()
  find(false, true)
}

function close(): void {
  delayedFind.cancel()
  isOpen.value = false
  clear()
  props.terminal.focus()
}

/** A history reset invalidates matches without stealing focus from the viewer. */
function reset(): void {
  delayedFind.cancel()
  query.value = ""
  clear()
}

function keydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === "Escape") {
    event.preventDefault()
    close()
  } else if ((event.key === "Enter" && event.target === input.value) || event.key === "F3") {
    event.preventDefault()
    find(event.shiftKey)
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault()
    focused.value = true
    input.value?.select()
  }
}

onBeforeUnmount(() => {
  delayedFind.cancel()
  subscription?.dispose()
  addon?.dispose()
})

defineExpose({ open, close, reset, isOpen })
</script>

<template>
  <section
    v-if="isOpen"
    role="search"
    :aria-label="t('terminal.searchLabel')"
    class="w-88 max-w-full rounded-lg border border-ui-border bg-ui-surface p-2 text-xs text-ui-text shadow-ui-popover"
    @keydown.stop="keydown"
  >
    <div class="flex min-w-0 items-center gap-1">
      <input
        ref="input"
        v-model="query"
        type="text"
        :aria-label="t('terminal.searchLabel')"
        :placeholder="t('terminal.searchPlaceholder')"
        :aria-invalid="invalidRegex || undefined"
        class="ui-input flex-1 py-1 text-xs"
        :class="invalidRegex && 'border-ui-danger'"
        autocomplete="off"
        spellcheck="false"
        @blur="addon?.clearActiveDecoration()"
      >
      <button type="button" :aria-label="t('terminal.searchClose')" :title="`${t('terminal.searchClose')} (Esc)`" class="ui-button-ghost h-7 w-7 shrink-0 p-0" @click="close"><X :size="14" aria-hidden="true" /></button>
    </div>
    <div class="mt-1 flex flex-wrap items-center gap-0.5">
      <button type="button" :aria-label="t('terminal.searchCaseSensitive')" :title="t('terminal.searchCaseSensitive')" :aria-pressed="caseSensitive" class="ui-button-ghost h-7 w-7 p-0" :class="caseSensitive && 'bg-ui-active text-ui-accent'" @click="caseSensitive = !caseSensitive"><CaseSensitive :size="15" aria-hidden="true" /></button>
      <button type="button" :aria-label="t('terminal.searchWholeWord')" :title="t('terminal.searchWholeWord')" :aria-pressed="wholeWord" class="ui-button-ghost h-7 w-7 p-0" :class="wholeWord && 'bg-ui-active text-ui-accent'" @click="wholeWord = !wholeWord"><WholeWord :size="15" aria-hidden="true" /></button>
      <button type="button" :aria-label="t('terminal.searchRegex')" :title="t('terminal.searchRegex')" :aria-pressed="regex" class="ui-button-ghost h-7 w-7 p-0" :class="regex && 'bg-ui-active text-ui-accent'" @click="regex = !regex"><Regex :size="15" aria-hidden="true" /></button>
      <span role="status" aria-live="polite" class="min-w-0 flex-1 px-1 text-ui-text-muted" :class="invalidRegex && 'text-ui-danger'">{{ resultLabel }}</span>
      <button type="button" :aria-label="t('terminal.searchPrevious')" :title="`${t('terminal.searchPrevious')} (Shift+Enter)`" :disabled="!query || invalidRegex" class="ui-button-ghost h-7 w-7 p-0" @click="find(true)"><ArrowUp :size="14" aria-hidden="true" /></button>
      <button type="button" :aria-label="t('terminal.searchNext')" :title="`${t('terminal.searchNext')} (Enter)`" :disabled="!query || invalidRegex" class="ui-button-ghost h-7 w-7 p-0" @click="find()"><ArrowDown :size="14" aria-hidden="true" /></button>
    </div>
  </section>
</template>
