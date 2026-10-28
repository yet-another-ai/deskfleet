<script setup lang="ts">
import { ChevronRight, GitBranch, ListTree, LoaderCircle, RefreshCw } from "@lucide/vue"
import { computed, nextTick, reactive, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { GitChangeKind, GitFileChange } from "../../../../../apps/daemon/src/git-protocol.ts"
import { useSessionGit } from "../../composables/useSessionGit.ts"
import { gitDiffCardKey } from "./git-diff-card.ts"
import IconButton from "../common/IconButton.vue"
import GitChangeFile from "./GitChangeFile.vue"
import GitDiffCard from "./GitDiffCard.vue"
import { buildChangeTree, flattenChangeTree, type ChangeTree, type ChangeTreeRow } from "./git-change-tree.ts"

const props = defineProps<{ sessionId: string; enabled: boolean }>()
const { t } = useI18n()
const { snapshot, loading, error, connected, cards, expand, collapse, refresh } = useSessionGit(() => props.sessionId, () => props.enabled)
const groups: GitChangeKind[] = ["staged", "unstaged", "untracked"]
const treeOpen = ref(false)
const collapsedDirectories = reactive<Record<string, true>>({})
const expanded = reactive<Record<string, true>>({})
const focused = ref<string | null>(null)
const cardsPane = ref<HTMLElement | null>(null)
const repositories = computed(() => snapshot.value?.repositories.map(repository => ({
  ...repository,
  groups: groups.map(kind => ({ kind, changes: repository.changes.filter(change => change.kind === kind) })).filter(group => group.changes.length),
})) ?? [])
const plainDirectories = computed(() => snapshot.value?.directories.filter(directory => !directory.repositoryId) ?? [])
const trees = computed(() => {
  const result = new Map<string, ChangeTree>()
  for (const repository of repositories.value) {
    for (const group of repository.groups) result.set(`${repository.id}\0${group.kind}`, buildChangeTree(group.changes))
  }
  return result
})
const emptyTree: ChangeTree = { directories: [], files: [] }

function directoryKey(repositoryId: string, kind: GitChangeKind, path: string): string {
  return `${repositoryId}\0${kind}\0${path}`
}
function treeFor(repositoryId: string, kind: GitChangeKind): ChangeTree {
  return trees.value.get(`${repositoryId}\0${kind}`) ?? emptyTree
}
function treeRows(repositoryId: string, kind: GitChangeKind): ChangeTreeRow[] {
  return flattenChangeTree(treeFor(repositoryId, kind), collapsedDirectories, path => directoryKey(repositoryId, kind, path))
}
function toggleDirectory(key: string): void {
  if (collapsedDirectories[key]) delete collapsedDirectories[key]
  else collapsedDirectories[key] = true
}
function cardKey(repositoryId: string, change: GitFileChange): string {
  return gitDiffCardKey(repositoryId, change.path, change.kind)
}
function toggleCard(repositoryId: string, change: GitFileChange): void {
  const key = cardKey(repositoryId, change)
  if (expanded[key]) {
    delete expanded[key]
    collapse(repositoryId, change.path, change.kind)
    return
  }
  expanded[key] = true
  focused.value = key
  expand(repositoryId, change)
}
function reveal(repositoryId: string, change: GitFileChange): void {
  const key = cardKey(repositoryId, change)
  expanded[key] = true
  focused.value = key
  expand(repositoryId, change)
  void nextTick(() => {
    const card = [...cardsPane.value?.querySelectorAll<HTMLElement>("[data-git-card]") ?? []].find(element => element.getAttribute("data-git-card") === key)
    card?.scrollIntoView({ block: "start" })
  })
}
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <p v-if="!enabled" class="m-0 px-4 pt-3 text-[13px] text-ui-text-muted" role="status">{{ t('panel.gitUnavailable') }}</p>
    <template v-else>
      <div class="flex shrink-0 items-center justify-between gap-2 px-3 pb-1 pt-2">
        <span class="text-xs text-ui-text-muted" role="status">{{ t(connected && !error ? 'panel.gitLive' : 'panel.gitPaused') }}</span>
        <div class="flex shrink-0">
          <IconButton :icon="ListTree" :label="t(treeOpen ? 'panel.hideFileTree' : 'panel.showFileTree')" :aria-pressed="treeOpen" aria-controls="git-file-tree" data-git-tree-toggle @click="treeOpen = !treeOpen" />
          <IconButton :icon="RefreshCw" :label="t('panel.refreshGit')" :disabled="loading" @click="refresh" />
        </div>
      </div>
      <p v-if="loading && !snapshot" class="m-0 flex shrink-0 items-center gap-2 px-3 text-[13px] text-ui-text-muted" role="status"><LoaderCircle :size="14" class="animate-spin" aria-hidden="true" />{{ t('panel.gitLoading') }}</p>
      <div v-if="error" class="flex shrink-0 flex-col gap-1 px-3 text-[13px]">
        <p class="m-0 break-words text-ui-danger" role="alert">{{ error }}</p>
        <p v-if="snapshot" class="m-0 text-ui-text-muted">{{ t('panel.gitStale') }}</p>
      </div>
      <div
        id="git-file-tree"
        class="flex min-h-0 min-w-0 flex-1 overflow-hidden"
        :class="treeOpen && 'flex-row'"
        :data-git-split="treeOpen ? '' : undefined"
      >
        <div
          v-if="treeOpen"
          class="min-h-0 w-[42%] max-w-52 min-w-0 shrink-0 overflow-y-auto border-r border-ui-border px-3 pb-4"
          role="navigation"
          :aria-label="t('panel.fileTree')"
          data-git-tree
        >
          <section v-for="repository in repositories" :key="repository.id" class="min-w-0">
            <h3 class="m-0 truncate text-[13px] font-medium" :title="repository.root">{{ repository.root }}</h3>
            <div class="mb-2 mt-1 flex min-w-0 items-center gap-1 text-xs text-ui-text-muted">
              <GitBranch :size="13" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
              <span class="truncate font-mono" :title="repository.head ?? undefined">{{ repository.branch ?? t('panel.detachedHead') }}</span>
              <span v-if="!repository.head" class="shrink-0">· {{ t('panel.noCommits') }}</span>
              <span v-else-if="!repository.branch" class="shrink-0 font-mono">{{ repository.head.slice(0, 8) }}</span>
            </div>
            <p v-if="repository.error" class="m-0 break-words text-[13px] text-ui-danger" role="alert">{{ repository.error }}</p>
            <p v-else-if="!repository.changes.length" class="m-0 text-[13px] text-ui-text-faint">{{ t('panel.clean') }}</p>
            <div v-for="group in repository.groups" :key="group.kind" class="mt-3" :data-kind="group.kind">
              <h4 class="m-0 mb-1 flex items-center justify-between text-xs font-medium text-ui-text-muted"><span>{{ t(`panel.changeKind.${group.kind}`) }}</span><span>{{ group.changes.length }}</span></h4>
              <ul>
                <li v-for="row in treeRows(repository.id, group.kind)" :key="`${row.type}:${row.path}`">
                  <button
                    v-if="row.type === 'directory'"
                    type="button"
                    class="flex min-h-7 w-full cursor-pointer items-center gap-1 rounded-md py-0.5 pr-1.5 text-left text-[13px] text-ui-text-muted hover:bg-ui-hover"
                    :style="{ paddingLeft: `${6 + row.depth * 12}px` }"
                    :aria-expanded="!row.collapsed"
                    :aria-label="t(row.collapsed ? 'panel.expandDirectory' : 'panel.collapseDirectory', { path: row.path })"
                    :data-git-directory="row.path"
                    :title="row.path"
                    @click="toggleDirectory(directoryKey(repository.id, group.kind, row.path))"
                  >
                    <ChevronRight :size="14" :stroke-width="1.75" class="shrink-0 transition-transform" :class="!row.collapsed && 'rotate-90'" aria-hidden="true" />
                    <span class="truncate">{{ row.name }}</span>
                  </button>
                  <GitChangeFile
                    v-else-if="row.change"
                    :change="row.change"
                    :repository-id="repository.id"
                    :depth="row.depth"
                    :selected="focused === cardKey(repository.id, row.change)"
                    :disabled="!connected"
                    @select="reveal(repository.id, row.change)"
                  />
                </li>
              </ul>
            </div>
          </section>
          <section v-for="directory in plainDirectories" :key="directory.path">
            <h3 class="m-0 mb-1 break-all text-[13px] font-medium">{{ directory.path }}</h3>
            <p v-if="directory.error" class="m-0 break-words text-[13px] text-ui-danger" role="alert">{{ directory.error }}</p>
            <p v-else class="m-0 text-[13px] text-ui-text-faint">{{ t('panel.notGit') }}</p>
          </section>
        </div>
        <div ref="cardsPane" data-git-cards class="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 pb-4">
          <section v-for="repository in repositories" :key="repository.id" :data-repository="repository.id" class="min-w-0">
            <h3 class="m-0 truncate text-[13px] font-medium" :title="repository.root">{{ repository.root }}</h3>
            <div class="mb-2 mt-1 flex min-w-0 items-center gap-1 text-xs text-ui-text-muted">
              <GitBranch :size="13" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
              <span class="truncate font-mono" :title="repository.head ?? undefined">{{ repository.branch ?? t('panel.detachedHead') }}</span>
              <span v-if="!repository.head" class="shrink-0">· {{ t('panel.noCommits') }}</span>
              <span v-else-if="!repository.branch" class="shrink-0 font-mono">{{ repository.head.slice(0, 8) }}</span>
            </div>
            <p v-if="repository.error" class="m-0 break-words text-[13px] text-ui-danger" role="alert">{{ repository.error }}</p>
            <p v-else-if="!repository.changes.length" class="m-0 text-[13px] text-ui-text-faint">{{ t('panel.clean') }}</p>
            <div v-for="group in repository.groups" :key="group.kind" class="mt-3" :data-kind="group.kind">
              <h4 class="m-0 mb-1 flex items-center justify-between text-xs font-medium text-ui-text-muted"><span>{{ t(`panel.changeKind.${group.kind}`) }}</span><span>{{ group.changes.length }}</span></h4>
              <GitDiffCard
                v-for="change in group.changes"
                :key="cardKey(repository.id, change)"
                :change="change"
                :repository-id="repository.id"
                :expanded="!!expanded[cardKey(repository.id, change)]"
                :focused="focused === cardKey(repository.id, change)"
                :card="cards.get(cardKey(repository.id, change))"
                :connected="connected && enabled"
                :panel-error="error"
                @toggle="toggleCard(repository.id, change)"
              />
            </div>
          </section>
          <template v-if="!treeOpen">
            <section v-for="directory in plainDirectories" :key="directory.path">
              <h3 class="m-0 mb-1 break-all text-[13px] font-medium">{{ directory.path }}</h3>
              <p v-if="directory.error" class="m-0 break-words text-[13px] text-ui-danger" role="alert">{{ directory.error }}</p>
              <p v-else class="m-0 text-[13px] text-ui-text-faint">{{ t('panel.notGit') }}</p>
            </section>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>
