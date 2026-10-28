<script setup lang="ts">
import { LoaderCircle } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { GitFileDiff } from "../../../../../apps/daemon/src/git-protocol.ts"
import { parseGitDiffLines } from "./git-diff-lines.ts"

const props = defineProps<{
  diff: GitFileDiff | null
  loading: boolean
  error: string | null
  connected: boolean
}>()
const { t } = useI18n()
const lines = computed(() => parseGitDiffLines(props.diff?.patch))
const lineClass = {
  added: "bg-ui-success/10 text-ui-success",
  deleted: "bg-ui-danger/10 text-ui-danger",
  hunk: "bg-ui-accent/8 text-ui-accent",
  meta: "text-ui-text-muted",
  context: "",
} as const
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
    <div v-else-if="lines.length" class="git-diff-content max-h-96 overflow-auto overscroll-contain" tabindex="0">
      <div class="w-max min-w-full py-2 font-mono text-xs leading-relaxed tab-4 select-text">
        <div v-for="(line, index) in lines" :key="index" class="grid grid-cols-[3.75rem_3.75rem_1fr]" :class="lineClass[line.kind]" :data-line-kind="line.kind">
          <span class="git-diff-number px-2.5 text-right text-ui-text-faint select-none" aria-hidden="true">{{ line.before }}</span>
          <span class="git-diff-number px-2.5 text-right text-ui-text-faint select-none" aria-hidden="true">{{ line.after }}</span>
          <span class="git-diff-text pr-4 pl-3 whitespace-pre">{{ line.text }}</span>
        </div>
      </div>
    </div>
    <p v-if="diff?.truncated" class="m-0 border-t border-ui-border px-3 py-2 text-[13px] text-ui-warning" role="status">{{ t('panel.truncatedDiff') }}</p>
  </div>
</template>
