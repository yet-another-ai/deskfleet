<script setup lang="ts">
import { ChevronRight } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { GitFileChange, GitFileStatus } from "../../../../../apps/daemon/src/git-protocol.ts"

const props = defineProps<{
  change: GitFileChange
  repositoryId: string
  depth?: number
  showParent?: boolean
  selected: boolean
  disabled: boolean
  /** Card header: the button expands and collapses that file's diff. */
  disclosure?: boolean
  expanded?: boolean
}>()
const emit = defineEmits<{ select: [] }>()
const { t } = useI18n()
const depth = computed(() => props.depth ?? 0)
const fileName = computed(() => {
  const index = props.change.path.lastIndexOf("/")
  return index < 0 ? props.change.path : props.change.path.slice(index + 1)
})
const parent = computed(() => {
  const index = props.change.path.lastIndexOf("/")
  return index < 0 ? "" : props.change.path.slice(0, index)
})
const statusLetter: Record<GitFileStatus, string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", untracked: "?", conflicted: "U", typeChanged: "T",
}
const statusColor: Record<GitFileStatus, string> = {
  modified: "text-ui-warning", added: "text-ui-success", deleted: "text-ui-danger", renamed: "text-ui-accent",
  copied: "text-ui-success", untracked: "text-ui-text-muted", conflicted: "text-ui-danger", typeChanged: "text-ui-warning",
}
</script>

<template>
  <button
    type="button"
    class="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md py-1 pr-1.5 text-left text-[13px] hover:bg-ui-hover disabled:cursor-default"
    :class="selected && 'bg-ui-active'"
    :style="{ paddingLeft: `${6 + depth * 12}px` }"
    :aria-label="disclosure ? t(expanded ? 'panel.collapseFileDiff' : 'panel.expandFileDiff', { path: change.path }) : t('panel.openDiff', { path: change.path, kind: t(`panel.changeKind.${change.kind}`) })"
    :aria-expanded="disclosure ? !!expanded : undefined"
    :aria-current="selected ? 'true' : undefined"
    :title="change.previousPath ? `${change.previousPath} → ${change.path}` : change.path"
    :data-git-path="change.path"
    :data-git-kind="change.kind"
    :data-git-repository="repositoryId"
    :disabled="disabled"
    @click="emit('select')"
  >
    <ChevronRight v-if="disclosure" :size="14" :stroke-width="1.75" class="shrink-0 text-ui-text-muted transition-transform" :class="expanded && 'rotate-90'" aria-hidden="true" />
    <span class="min-w-0 flex-1 truncate">
      <span :class="change.status === 'deleted' && 'line-through op-70'">{{ fileName }}</span>
      <span v-if="showParent && parent" class="ml-1.5 text-xs text-ui-text-faint">{{ parent }}</span>
    </span>
    <span class="shrink-0 font-mono text-[11px]">
      <span v-if="change.additions" class="text-ui-success">+{{ change.additions }}</span>
      <span v-if="change.deletions" class="ml-1 text-ui-danger">−{{ change.deletions }}</span>
    </span>
    <span class="w-3 shrink-0 text-center font-mono text-xs font-semibold" :class="statusColor[change.status]" :title="t(`panel.changeStatus.${change.status}`)">{{ statusLetter[change.status] }}</span>
  </button>
</template>
