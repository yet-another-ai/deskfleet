<script setup lang="ts">
import { LoaderCircle, RefreshCw, X } from "@lucide/vue"
import { computed, onBeforeUnmount, onMounted, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { GitDiffRequest, GitFileDiff } from "../../../../../apps/daemon/src/git-protocol.ts"
import IconButton from "../common/IconButton.vue"

const props = defineProps<{
  selection: GitDiffRequest
  repository?: string
  diff: GitFileDiff | null
  loading: boolean
  error: string | null
  connected: boolean
}>()
const emit = defineEmits<{ close: []; refresh: [] }>()
const { t } = useI18n()
const dialog = useTemplateRef<HTMLDialogElement>("dialog")
let closed = false

interface DiffLine { text: string; kind: "meta" | "hunk" | "context" | "added" | "deleted"; before?: number; after?: number }
const lines = computed<DiffLine[]>(() => {
  const patch = props.diff?.patch
  if (!patch) return []
  const result: DiffLine[] = []
  let before = 0, after = 0, beforeLeft = 0, afterLeft = 0
  const source = patch.split("\n")
  if (source.at(-1) === "") source.pop()
  for (const text of source) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(text)
    if (hunk) {
      before = Number(hunk[1]); after = Number(hunk[3])
      beforeLeft = Number(hunk[2] ?? 1); afterLeft = Number(hunk[4] ?? 1)
      result.push({ text, kind: "hunk" })
    } else if (beforeLeft > 0 && text.startsWith("-")) {
      result.push({ text, kind: "deleted", before: before++ }); beforeLeft--
    } else if (afterLeft > 0 && text.startsWith("+")) {
      result.push({ text, kind: "added", after: after++ }); afterLeft--
    } else if (beforeLeft > 0 && afterLeft > 0 && text.startsWith(" ")) {
      result.push({ text, kind: "context", before: before++, after: after++ }); beforeLeft--; afterLeft--
    } else result.push({ text, kind: "meta" })
  }
  return result
})

function close(): void {
  if (closed) return
  closed = true
  dialog.value?.close()
  emit("close")
}
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => { closed = true; dialog.value?.close() })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="ui-dialog git-diff-dialog app-no-drag" aria-labelledby="git-diff-title" :data-git-diff="selection.kind" :data-git-path="selection.path" @cancel.prevent.stop="close" @close.stop="close">
      <header class="flex shrink-0 items-start justify-between gap-4 border-b border-ui-border p-4">
        <div class="min-w-0">
          <h2 id="git-diff-title" class="m-0 break-all font-mono text-sm font-semibold select-text">{{ selection.path }}</h2>
          <p class="m-0 mt-1 flex flex-wrap gap-x-2 text-xs text-ui-text-muted"><span>{{ t(`panel.changeKind.${selection.kind}`) }}</span><span v-if="repository" class="break-all select-text">{{ repository }}</span></p>
        </div>
        <div class="flex shrink-0 gap-1">
          <IconButton :icon="RefreshCw" :label="t('panel.refreshGit')" :disabled="loading" @click="emit('refresh')" />
          <IconButton :icon="X" :label="t('panel.closeDiff')" @click="close" />
        </div>
      </header>
      <div v-if="error || !connected" class="shrink-0 border-b border-ui-border px-4 py-3 text-[13px]">
        <p v-if="error" class="m-0 break-words text-ui-danger" role="alert">{{ error }}</p>
        <p v-if="!connected" class="m-0 text-ui-warning" role="status">{{ t('panel.gitPaused') }}</p>
        <p v-if="diff" class="m-0 mt-1 text-ui-text-muted">{{ t('panel.gitStale') }}</p>
      </div>
      <p v-if="loading && !diff" class="m-0 flex items-center gap-2 p-6 text-sm text-ui-text-muted" role="status"><LoaderCircle :size="16" class="animate-spin" aria-hidden="true" />{{ t('panel.diffLoading') }}</p>
      <p v-else-if="diff?.binary" class="m-0 p-6 text-sm text-ui-text-muted" role="status">{{ t('panel.binaryDiff') }}</p>
      <p v-else-if="diff && !diff.patch" class="m-0 p-6 text-sm text-ui-text-muted" role="status">{{ t('panel.emptyDiff') }}</p>
      <div v-else-if="lines.length" class="git-diff-content min-h-0 flex-1 overflow-auto" tabindex="0" :aria-label="t('panel.diffContent')">
        <div class="git-diff-lines font-mono text-xs select-text">
          <div v-for="(line, index) in lines" :key="index" class="git-diff-line" :class="`git-diff-${line.kind}`" :data-line-kind="line.kind">
            <span class="git-diff-number select-none" aria-hidden="true">{{ line.before }}</span>
            <span class="git-diff-number select-none" aria-hidden="true">{{ line.after }}</span>
            <span class="git-diff-text">{{ line.text }}</span>
          </div>
        </div>
      </div>
      <p v-if="diff?.truncated" class="m-0 shrink-0 border-t border-ui-border px-4 py-3 text-[13px] text-ui-warning" role="status">{{ t('panel.truncatedDiff') }}</p>
    </dialog>
  </Teleport>
</template>

<style scoped>
.git-diff-dialog {
  width: min(70rem, calc(100vw - 2rem));
  max-height: calc(100vh - 2rem);
  padding: 0;
}
.git-diff-dialog[open] { display: flex; flex-direction: column; }
.git-diff-content { overscroll-behavior: contain; }
.git-diff-lines { width: max-content; min-width: 100%; padding: 0.5rem 0; line-height: 1.65; tab-size: 4; }
.git-diff-line { display: grid; grid-template-columns: 3.75rem 3.75rem 1fr; }
.git-diff-number { padding: 0 0.625rem; text-align: right; color: var(--ui-color-text-faint); }
.git-diff-text { padding: 0 1rem 0 0.75rem; white-space: pre; }
.git-diff-added { background: color-mix(in srgb, var(--ui-color-success) 10%, transparent); color: var(--ui-color-success); }
.git-diff-deleted { background: color-mix(in srgb, var(--ui-color-danger) 10%, transparent); color: var(--ui-color-danger); }
.git-diff-hunk { background: color-mix(in srgb, var(--ui-color-accent) 8%, transparent); color: var(--ui-color-accent); }
.git-diff-meta { color: var(--ui-color-text-muted); }
</style>
