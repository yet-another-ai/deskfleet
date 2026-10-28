<script setup lang="ts">
import { LoaderCircle, X } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { GitDiffRequest, GitFileDiff } from "../../../../../apps/daemon/src/git-protocol.ts"
import IconButton from "../common/IconButton.vue"
import { parseGitDiffLines } from "./git-diff-lines.ts"

const props = defineProps<{
  selection: GitDiffRequest
  repository?: string
  diff: GitFileDiff | null
  loading: boolean
  error: string | null
  connected: boolean
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const lines = computed(() => parseGitDiffLines(props.diff?.patch))
</script>

<template>
  <section
    class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    :data-git-diff="selection.kind"
    :data-git-path="selection.path"
    :aria-label="t('panel.diffContent')"
    @keydown.escape.stop.prevent="emit('close')"
  >
    <header class="flex shrink-0 items-start justify-between gap-2 border-b border-ui-border px-3 py-2">
      <div class="min-w-0">
        <p class="m-0 truncate font-mono text-[13px] font-semibold" :title="selection.path">{{ selection.path }}</p>
        <p class="m-0 mt-0.5 flex min-w-0 gap-x-2 text-xs text-ui-text-muted">
          <span class="shrink-0">{{ t(`panel.changeKind.${selection.kind}`) }}</span>
          <span v-if="repository" class="truncate" :title="repository">{{ repository }}</span>
        </p>
      </div>
      <IconButton :icon="X" :label="t('panel.closeDiff')" @click="emit('close')" />
    </header>
    <div v-if="error || !connected" class="shrink-0 border-b border-ui-border px-3 py-2 text-[13px]">
      <p v-if="error" class="m-0 break-words text-ui-danger" role="alert">{{ error }}</p>
      <p v-if="!connected" class="m-0 text-ui-warning" role="status">{{ t('panel.gitPaused') }}</p>
      <p v-if="diff" class="m-0 mt-1 text-ui-text-muted">{{ t('panel.gitStale') }}</p>
    </div>
    <p v-if="loading && !diff" class="m-0 flex items-center gap-2 px-3 py-4 text-sm text-ui-text-muted" role="status"><LoaderCircle :size="16" class="animate-spin" aria-hidden="true" />{{ t('panel.diffLoading') }}</p>
    <p v-else-if="diff?.binary" class="m-0 px-3 py-4 text-sm text-ui-text-muted" role="status">{{ t('panel.binaryDiff') }}</p>
    <p v-else-if="diff && !diff.patch" class="m-0 px-3 py-4 text-sm text-ui-text-muted" role="status">{{ t('panel.emptyDiff') }}</p>
    <div v-else-if="lines.length" class="git-diff-content min-h-0 flex-1 overflow-auto" tabindex="0">
      <div class="git-diff-lines font-mono text-xs select-text">
        <div v-for="(line, index) in lines" :key="index" class="git-diff-line" :class="`git-diff-${line.kind}`" :data-line-kind="line.kind">
          <span class="git-diff-number select-none" aria-hidden="true">{{ line.before }}</span>
          <span class="git-diff-number select-none" aria-hidden="true">{{ line.after }}</span>
          <span class="git-diff-text">{{ line.text }}</span>
        </div>
      </div>
    </div>
    <p v-if="diff?.truncated" class="m-0 shrink-0 border-t border-ui-border px-3 py-2 text-[13px] text-ui-warning" role="status">{{ t('panel.truncatedDiff') }}</p>
  </section>
</template>

<style scoped>
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
