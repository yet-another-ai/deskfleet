<script setup lang="ts">
import { computed, ref } from "vue"
import type { GitFileChange, GitFileDiff } from "../../../../../apps/daemon/src/git-protocol.ts"
import type { GitDiffCard } from "./git-diff-card.ts"
import GitChangeFile from "./GitChangeFile.vue"
import GitDiffView from "./GitDiffView.vue"

const props = defineProps<{
  change: GitFileChange
  repositoryId: string
  expanded: boolean
  card?: GitDiffCard
  connected: boolean
  panelError: string | null
}>()
const emit = defineEmits<{ toggle: [] }>()
const element = ref<HTMLElement | null>(null)
const diff = computed<GitFileDiff | null>(() => props.card?.diff ?? null)
defineExpose({ element })
</script>

<template>
  <article
    ref="element"
    class="mb-2 flex flex-col overflow-hidden rounded-md border border-ui-border"
    :data-git-path="change.path"
    :data-git-kind="change.kind"
    :data-git-diff="expanded ? change.kind : undefined"
  >
    <header>
      <GitChangeFile disclosure :change="change" :repository-id="repositoryId" show-parent :expanded="expanded" :selected="expanded" :disabled="false" @select="emit('toggle')" />
    </header>
    <GitDiffView v-if="expanded" class="border-t border-ui-border" :diff="diff" :loading="!card || card.loading" :error="card?.error || panelError" :connected="connected" />
  </article>
</template>
