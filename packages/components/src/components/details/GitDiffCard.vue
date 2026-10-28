<script setup lang="ts">
import { computed } from "vue"
import type { GitFileChange, GitFileDiff } from "../../../../../apps/daemon/src/git-protocol.ts"
import { gitDiffCardKey, type GitDiffCard } from "./git-diff-card.ts"
import GitChangeFile from "./GitChangeFile.vue"
import GitDiffView from "./GitDiffView.vue"

const props = defineProps<{
  change: GitFileChange
  repositoryId: string
  expanded: boolean
  focused: boolean
  card?: GitDiffCard
  connected: boolean
  panelError: string | null
}>()
const emit = defineEmits<{ toggle: [] }>()
const key = computed(() => gitDiffCardKey(props.repositoryId, props.change.path, props.change.kind))
const diff = computed<GitFileDiff | null>(() => props.card?.diff ?? null)
</script>

<template>
  <article
    :id="`git-card-${encodeURIComponent(key)}`"
    class="mb-2 overflow-hidden rounded-md border border-ui-border"
    :class="expanded && 'flex flex-col'"
    :data-git-card="key"
    :data-git-path="change.path"
    :data-git-kind="change.kind"
    :data-git-diff="expanded ? change.kind : undefined"
  >
    <header class="bg-ui-surface">
      <GitChangeFile disclosure :change="change" :repository-id="repositoryId" show-parent :expanded="expanded" :selected="focused" :disabled="false" @select="emit('toggle')" />
    </header>
    <GitDiffView v-if="expanded" class="border-t border-ui-border" :diff="diff" :loading="!card || card.loading" :error="card?.error || panelError" :connected="connected" />
  </article>
</template>
