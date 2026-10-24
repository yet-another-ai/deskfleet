<script setup lang="ts">
import { GitBranch, LoaderCircle, RefreshCw } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { GitChangeKind, GitFileStatus } from "../../../../../apps/daemon/src/git-protocol.ts"
import { useSessionGit } from "../../composables/useSessionGit.ts"
import IconButton from "../common/IconButton.vue"
import GitDiffDialog from "./GitDiffDialog.vue"

const props = defineProps<{ sessionId: string; enabled: boolean }>()
const { t } = useI18n()
const { snapshot, loading, error, connected, selection, diff, diffLoading, diffError, refresh, select, closeDiff } = useSessionGit(() => props.sessionId, () => props.enabled)
const groups: GitChangeKind[] = ["staged", "unstaged", "untracked"]
const repositories = computed(() => snapshot.value?.repositories.map(repository => ({
  ...repository,
  groups: groups.map(kind => ({ kind, changes: repository.changes.filter(change => change.kind === kind) })).filter(group => group.changes.length),
})) ?? [])
const plainDirectories = computed(() => snapshot.value?.directories.filter(directory => !directory.repositoryId) ?? [])
const selectedRepository = computed(() => snapshot.value?.repositories.find(repository => repository.id === selection.value?.repositoryId))
const statusLetter: Record<GitFileStatus, string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", untracked: "?", conflicted: "U", typeChanged: "T",
}
const statusColor: Record<GitFileStatus, string> = {
  modified: "text-ui-warning", added: "text-ui-success", deleted: "text-ui-danger", renamed: "text-ui-accent",
  copied: "text-ui-success", untracked: "text-ui-text-muted", conflicted: "text-ui-danger", typeChanged: "text-ui-warning",
}
function fileName(path: string): string { return path.slice(path.lastIndexOf("/") + 1) }
function parent(path: string): string { const index = path.lastIndexOf("/"); return index < 0 ? "" : path.slice(0, index) }
</script>

<template>
  <div class="flex flex-col gap-4">
    <p v-if="!enabled" class="m-0 text-[13px] text-ui-text-muted" role="status">{{ t('panel.gitUnavailable') }}</p>
    <template v-else>
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-ui-text-muted" role="status">{{ t(connected && !error ? 'panel.gitLive' : 'panel.gitPaused') }}</span>
        <IconButton :icon="RefreshCw" :label="t('panel.refreshGit')" :disabled="loading" @click="refresh" />
      </div>
      <p v-if="loading && !snapshot" class="m-0 flex items-center gap-2 text-[13px] text-ui-text-muted" role="status"><LoaderCircle :size="14" class="animate-spin" aria-hidden="true" />{{ t('panel.gitLoading') }}</p>
      <div v-if="error" class="flex flex-col gap-1 text-[13px]">
        <p class="m-0 break-words text-ui-danger" role="alert">{{ error }}</p>
        <p v-if="snapshot" class="m-0 text-ui-text-muted">{{ t('panel.gitStale') }}</p>
      </div>
      <section v-for="repository in repositories" :key="repository.id" :data-repository="repository.id">
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
            <li v-for="change in group.changes" :key="change.path">
              <button type="button" class="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-ui-hover" :aria-label="t('panel.openDiff', { path: change.path, kind: t(`panel.changeKind.${change.kind}`) })" :title="change.previousPath ? `${change.previousPath} → ${change.path}` : change.path" :data-git-path="change.path" :data-git-kind="change.kind" :data-git-repository="repository.id" :disabled="!connected" @click="select(repository.id, change)">
                <span class="min-w-0 flex-1 truncate">
                  <span :class="change.status === 'deleted' && 'line-through op-70'">{{ fileName(change.path) }}</span>
                  <span class="ml-1.5 text-xs text-ui-text-faint">{{ parent(change.path) }}</span>
                </span>
                <span class="shrink-0 font-mono text-[11px]">
                  <span v-if="change.additions" class="text-ui-success">+{{ change.additions }}</span>
                  <span v-if="change.deletions" class="ml-1 text-ui-danger">−{{ change.deletions }}</span>
                </span>
                <span class="w-3 shrink-0 text-center font-mono text-xs font-semibold" :class="statusColor[change.status]" :title="t(`panel.changeStatus.${change.status}`)">{{ statusLetter[change.status] }}</span>
              </button>
            </li>
          </ul>
        </div>
      </section>
      <section v-for="directory in plainDirectories" :key="directory.path">
        <h3 class="m-0 mb-1 break-all text-[13px] font-medium">{{ directory.path }}</h3>
        <p v-if="directory.error" class="m-0 break-words text-[13px] text-ui-danger" role="alert">{{ directory.error }}</p>
        <p v-else class="m-0 text-[13px] text-ui-text-faint">{{ t('panel.notGit') }}</p>
      </section>
    </template>
    <GitDiffDialog v-if="selection" :selection="selection" :repository="selectedRepository?.root" :diff="diff" :loading="diffLoading" :error="diffError || error" :connected="connected && enabled" @close="closeDiff" @refresh="refresh" />
  </div>
</template>
