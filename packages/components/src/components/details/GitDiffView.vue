<script setup lang="ts">
import { LoaderCircle, Plus } from "@lucide/vue"
import { useEventListener } from "@vueuse/core"
import { computed, nextTick, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { GitFileDiff } from "../../../../../apps/daemon/src/git-protocol.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import UiScrollArea from "../common/UiScrollArea.vue"
import { isCommentableDiffLine, normalizeDiffSelection, parseGitDiffLines, selectedDiffLineIndices, syncDiffAttachments } from "./git-diff-lines.ts"

const props = defineProps<{ diff: GitFileDiff | null; loading: boolean; error: string | null; connected: boolean }>()
const { t } = useI18n()
const agents = (() => { try { return useAgentSessionsStore() } catch { return undefined } })()
const lines = computed(() => parseGitDiffLines(props.diff?.patch))
const drag = ref<{ anchor: number; focus: number } | null>(null)
const lastAnchor = ref<number | null>(null)

const canComment = computed(() => Boolean(props.diff && !props.diff.binary && props.connected && agents))
const committedIndices = computed(() => (props.diff && agents ? selectedDiffLineIndices(agents.draftAttachments[props.diff.sessionId] ?? [], props.diff, lines.value) : new Set<number>()))
const dragSelection = computed(() => (drag.value ? normalizeDiffSelection(lines.value, drag.value.anchor, drag.value.focus) : null))
const isLineSelected = (index: number) => isCommentableDiffLine(lines.value[index]) && (committedIndices.value.has(index) || Boolean(dragSelection.value && index >= dragSelection.value.startIndex && index <= dragSelection.value.endIndex))
const lineClass = { added: "bg-ui-success/10 text-ui-success", deleted: "bg-ui-danger/10 text-ui-danger", hunk: "bg-ui-accent/8 text-ui-accent", meta: "text-ui-text-muted", context: "" } as const

function clearSelection(): void {
  drag.value = null
  lastAnchor.value = null
}

function commitIndices(next: Set<number>): void {
  if (!props.diff || !agents) return
  agents.draftAttachments[props.diff.sessionId] = syncDiffAttachments(agents.draftAttachments[props.diff.sessionId] ?? [], props.diff, lines.value, next)
  if (next.size) void nextTick(() => { document.querySelector<HTMLTextAreaElement>("[data-composer-input], .session-composer textarea")?.focus() })
}

function addRange(start: number, end: number): void {
  const range = normalizeDiffSelection(lines.value, start, end)
  if (!range) return
  const next = new Set(committedIndices.value)
  for (let i = range.startIndex; i <= range.endIndex; i++) next.add(i)
  commitIndices(next)
}

function onLinePointerDown(index: number, event: PointerEvent): void {
  if (event.button !== 0 || event.shiftKey || !canComment.value) return
  event.preventDefault()
  drag.value = { anchor: index, focus: index }
}

function onLinePointerEnter(index: number): void {
  if (drag.value && isCommentableDiffLine(lines.value[index])) drag.value.focus = index
}

useEventListener("pointerup", () => {
  const current = drag.value
  drag.value = null
  if (!current || current.anchor === current.focus) return
  lastAnchor.value = current.focus
  addRange(current.anchor, current.focus)
})
useEventListener("pointercancel", () => { drag.value = null })

function onLineClick(index: number, event: MouseEvent): void {
  if (!canComment.value || !isCommentableDiffLine(lines.value[index])) return
  if (event.shiftKey && lastAnchor.value !== null) return addRange(lastAnchor.value, index)
  const next = new Set(committedIndices.value)
  if (next.delete(index)) {
    lastAnchor.value = null
  } else {
    next.add(index)
    lastAnchor.value = index
  }
  commitIndices(next)
}

watch(committedIndices, indices => {
  if (lastAnchor.value !== null && !indices.has(lastAnchor.value)) lastAnchor.value = null
})
watch(() => [props.diff?.repositoryId, props.diff?.path, props.diff?.kind] as const, clearSelection)
</script>

<template>
  <div>
    <div v-if="error || !connected" class="border-b border-ui-border px-3 py-2 text-[13px]">
      <p v-if="error" class="m-0 break-words text-ui-danger" role="alert">{{ error }}</p>
      <p v-if="!connected" class="m-0 text-ui-warning" role="status">{{ t('panel.gitPaused') }}</p>
      <p v-if="diff" class="m-0 mt-1 text-ui-text-muted">{{ t('panel.gitStale') }}</p>
    </div>
    <p v-if="loading && !diff" class="m-0 flex items-center gap-2 px-3 py-4 text-sm text-ui-text-muted" role="status"><LoaderCircle :size="16" class="animate-spin" aria-hidden="true" />{{ t('panel.diffLoading') }}</p>
    <p v-else-if="diff?.binary" class="m-0 px-3 py-4 text-sm text-ui-text-muted" role="status">{{ t('panel.binaryDiff') }}</p>
    <p v-else-if="diff && !diff.patch" class="m-0 px-3 py-4 text-sm text-ui-text-muted" role="status">{{ t('panel.emptyDiff') }}</p>
    <UiScrollArea v-else-if="lines.length" orientation="both" fade-size="sm" class="git-diff-content max-h-96" viewport-class="overscroll-contain">
      <div class="w-max min-w-full py-2 font-mono text-xs leading-relaxed tab-4 select-text">
        <div v-for="(line, index) in lines" :key="index" class="group/line grid grid-cols-[7.5rem_1fr]" :class="[lineClass[line.kind], isLineSelected(index) && 'bg-ui-accent/15 shadow-[inset_2px_0_0_var(--ui-color-accent)]']" :data-line-kind="line.kind" :data-line-index="index" :data-line-selected="isLineSelected(index) ? 'true' : undefined">
          <button v-if="isCommentableDiffLine(line)" type="button" class="relative grid grid-cols-2 items-center border-0 bg-transparent p-0 text-inherit font-inherit leading-inherit select-none ui-motion" :class="canComment ? 'cursor-pointer hover:bg-ui-hover focus-visible:bg-ui-hover focus-visible:outline-none' : 'cursor-default'" :disabled="!canComment" :aria-label="t('panel.addLineComment', { line: line.after ?? line.before ?? '' })" :aria-pressed="isLineSelected(index)" data-diff-line-select @pointerdown="onLinePointerDown(index, $event)" @pointerenter="onLinePointerEnter(index)" @click="onLineClick(index, $event)">
            <span v-if="canComment" class="pointer-events-none absolute left-1 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded bg-ui-action text-ui-action-text opacity-0 ui-motion group-hover/line:opacity-100 group-focus-within/line:opacity-100" :class="isLineSelected(index) && 'opacity-100'" aria-hidden="true"><Plus :size="11" :stroke-width="2.5" /></span>
            <span class="git-diff-number px-2.5 text-right text-ui-text-faint select-none" aria-hidden="true">{{ line.before }}</span>
            <span class="git-diff-number px-2.5 text-right text-ui-text-faint select-none" aria-hidden="true">{{ line.after }}</span>
          </button>
          <div v-else class="grid grid-cols-2 select-none">
            <span class="git-diff-number px-2.5 text-right text-ui-text-faint select-none" aria-hidden="true">{{ line.before }}</span>
            <span class="git-diff-number px-2.5 text-right text-ui-text-faint select-none" aria-hidden="true">{{ line.after }}</span>
          </div>
          <span class="git-diff-text pr-4 pl-3 whitespace-pre">{{ line.text }}</span>
        </div>
      </div>
    </UiScrollArea>
    <p v-if="diff?.truncated" class="m-0 border-t border-ui-border px-3 py-2 text-[13px] text-ui-warning" role="status">{{ t('panel.truncatedDiff') }}</p>
  </div>
</template>
