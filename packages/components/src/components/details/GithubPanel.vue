<script setup lang="ts">
import { CircleDot, GitPullRequest, ListPlus, RefreshCw } from "@lucide/vue"
import { useAsyncState, useEventBus } from "@vueuse/core"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { GithubAppSettings, GithubRepositoryItem } from "@deskfleet/client/central"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { withGithubReference, writeGithubItemDrag } from "../../services/github-composer-reference.ts"
import { githubSettingsChanged } from "../../services/github-settings-events.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import UiButton from "../common/UiButton.vue"
import UiScrollArea from "../common/UiScrollArea.vue"
import UiSelect from "../common/UiSelect.vue"

const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ insert: [] }>()
const { t } = useI18n()
const fleet = useFleetStore()
const agents = useAgentSessionsStore()
const account = useAccountSession()
const location = computed(() => fleet.findSession(props.sessionId))
const repositories = computed(() => location.value?.workspace?.githubRepositories ?? [])
const selectedRepository = ref("")
const repository = computed(() => repositories.value.includes(selectedRepository.value) ? selectedRepository.value : repositories.value[0])
const kind = ref<GithubRepositoryItem["kind"]>("issue")
const kinds = ["issue", "pullRequest"] as const
const page = ref(1)
const scope = computed(() => {
  const workspaceId = location.value?.workspace?.id
  return fleet.catalogIdentity && workspaceId ? { ...fleet.catalogIdentity, workspaceId } : undefined
})
const archiveState = computed(() => location.value?.session.archiveState)
const canInsert = computed(() => !!scope.value && (!archiveState.value || archiveState.value === "active"))
const access = useAsyncState(async (known?: GithubAppSettings) => known ?? await account?.central.githubSettings(),
  undefined, { immediate: !!account })
const permitted = computed(() => !!(access.state.value?.configured && access.state.value.authorized && access.state.value.actAsYou))
useEventBus(githubSettingsChanged).on(event => {
  if (event.central === account?.central) void access.executeImmediate(event.settings)
})
const { state: result, error, isLoading, executeImmediate: reload } = useAsyncState(async () => {
  if (!repository.value || !permitted.value || !account) return
  const [owner, repo] = repository.value.split("/") as [string, string]
  return account.central.githubRepositoryItems({ owner, repo, kind: kind.value, page: page.value })
}, undefined, { immediate: false })
watch([repository, kind], () => { page.value = 1 }, { flush: "sync" })
watch([repository, kind, page, permitted], () => { void reload() }, { immediate: true })
function failureText(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }

function drag(event: DragEvent, item: GithubRepositoryItem): void {
  if (!scope.value || !event.dataTransfer) return
  writeGithubItemDrag(event.dataTransfer, scope.value, item)
}
function insert(item: GithubRepositoryItem): void {
  if (!canInsert.value) return
  agents.draftAttachments[props.sessionId] = withGithubReference(agents.draftAttachments[props.sessionId] ?? [], item)
  emit("insert")
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-ui-canvas text-ui-text" :aria-label="t('githubSettings.title')">
    <header v-if="repository" class="flex min-w-0 flex-wrap items-center gap-2 border-b border-ui-border px-3 py-2">
      <UiSelect v-if="repositories.length > 1" :model-value="repository" :options="repositories.map(value => ({ value, label: value }))" :aria-label="t('githubPanel.repository')" class="min-w-0 flex-1" @update:model-value="selectedRepository = $event" />
      <span v-else class="min-w-0 flex-1 truncate text-[13px] font-medium" :title="repository">{{ repository }}</span>
      <UiButton v-if="account" size="icon" variant="ghost" :label="t('githubPanel.refresh')" :disabled="access.isLoading.value || isLoading" @click="access.executeImmediate()"><RefreshCw :size="14" aria-hidden="true" /></UiButton>
    </header>
    <p v-if="!repository" class="m-3 text-sm text-ui-text-muted">{{ t("githubPanel.noRepository") }}</p>
    <div v-else-if="access.error.value" class="m-3 flex flex-col items-start gap-2 text-sm">
      <p class="m-0 text-ui-danger" role="alert">{{ failureText(access.error.value) }}</p>
      <UiButton size="sm" @click="access.executeImmediate()">{{ t("errors.retry") }}</UiButton>
      <RouterLink v-if="account" :to="{ name: 'settings-github' }" class="text-ui-accent">{{ t("githubSettings.returnToSettings") }}</RouterLink>
    </div>
    <p v-else-if="access.isLoading.value" role="status" class="m-3 text-sm text-ui-text-muted">{{ t("githubPanel.loading") }}</p>
    <p v-else-if="!access.state.value?.configured" role="status" class="m-3 text-sm text-ui-text-muted">{{ t("githubSettings.unavailable") }}</p>
    <div v-else-if="!permitted" class="m-3 flex flex-col items-start gap-2 text-sm">
      <p class="m-0 text-ui-text-muted">{{ t("githubPanel.connect") }}</p>
      <RouterLink :to="{ name: 'settings-github' }" class="text-ui-accent">{{ t("githubSettings.returnToSettings") }}</RouterLink>
    </div>
    <template v-else>
      <div class="flex gap-1 border-b border-ui-border px-2 py-1.5">
        <button v-for="option in kinds" :key="option" type="button" :aria-pressed="kind === option" :class="kind === option ? 'bg-ui-hover text-ui-text' : 'text-ui-text-muted hover:text-ui-text'" class="rounded-md px-2 py-1 text-xs font-medium" @click="kind = option">{{ t(`githubPanel.${option}`) }}</button>
      </div>
      <p v-if="isLoading" role="status" class="m-3 text-sm text-ui-text-muted">{{ t("githubPanel.loading") }}</p>
      <div v-else-if="error" class="m-3 flex flex-col items-start gap-2 text-sm">
        <p class="m-0 text-ui-danger" role="alert">{{ failureText(error) }}</p>
        <UiButton size="sm" @click="reload()">{{ t("errors.retry") }}</UiButton>
        <RouterLink :to="{ name: 'settings-github' }" class="text-ui-accent">{{ t("githubSettings.returnToSettings") }}</RouterLink>
      </div>
      <UiScrollArea v-else-if="result" :key="`${repository}:${kind}:${page}`" class="min-h-0 flex-1">
        <ul v-if="result.items.length" class="m-0 list-none p-0">
          <li v-for="item in result.items" :key="item.url" draggable="true" class="group flex cursor-grab items-start gap-2 border-b border-ui-border px-3 py-2.5 hover:bg-ui-hover active:cursor-grabbing" @dragstart="drag($event, item)">
            <component :is="kind === 'issue' ? CircleDot : GitPullRequest" :size="15" aria-hidden="true" class="mt-0.5 shrink-0 text-ui-success" />
            <a :href="item.url" target="_blank" rel="noopener noreferrer" draggable="false" class="min-w-0 flex-1 break-words text-[13px] leading-snug text-ui-text hover:underline">
              {{ item.title }}<span class="mt-1 block text-xs text-ui-text-muted">#{{ item.number }}</span>
            </a>
            <UiButton size="icon" variant="ghost" :disabled="!canInsert" :label="t('githubPanel.insert', { number: item.number })" @click="insert(item)"><ListPlus :size="16" aria-hidden="true" /></UiButton>
          </li>
        </ul>
        <p v-else role="status" class="m-3 text-sm text-ui-text-muted">{{ t(kind === "issue" ? "githubPanel.emptyIssues" : "githubPanel.emptyPullRequests") }}</p>
      </UiScrollArea>
      <nav v-if="page > 1 || result?.nextPage" class="mt-auto flex items-center justify-between border-t border-ui-border px-3 py-2">
        <UiButton size="sm" :disabled="page <= 1 || isLoading" @click="page--">{{ t("githubPanel.previous") }}</UiButton>
        <UiButton size="sm" :disabled="!result?.nextPage" @click="page = result?.nextPage ?? page">{{ t("githubPanel.next") }}</UiButton>
      </nav>
    </template>
  </section>
</template>
