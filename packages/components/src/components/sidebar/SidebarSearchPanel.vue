<script setup lang="ts">
import { CalendarClock, LoaderCircle, MessagesSquare, Search } from "@lucide/vue"
import { useFocus } from "@vueuse/core"
import { computed, useId, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter } from "vue-router"
import type { SearchResult } from "@deskfleet/client/search"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useSearch, type SearchKind } from "../../composables/useSearch.ts"
import { useSidebarPanel } from "../../composables/useSidebarPanel.ts"
import SearchHighlight from "../search/SearchHighlight.vue"
import UiButton from "../common/UiButton.vue"
import UiScrollArea from "../common/UiScrollArea.vue"

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const account = useAccountSession()
const sidebarPanel = useSidebarPanel()
const inputId = useId()
const input = useTemplateRef<HTMLInputElement>("input")
useFocus(input, { initialValue: true })

const query = sidebarPanel.searchQuery
const kind = sidebarPanel.searchKind
const kinds: readonly SearchKind[] = ["all", "chat", "schedule"] as const
const search = useSearch(query, kind)
const { results, nextCursor, loading, error, available } = search
const empty = computed(() => !!query.value.trim() && !loading.value && !error.value && !results.value.length)

watch(() => account?.teamId.value, () => {
  query.value = ""
  kind.value = "all"
})

function isActiveResult(result: SearchResult): boolean {
  if (result.kind === "chat") {
    return route.name === "session" && route.params.sessionId === result.resourceId
      && (!account || account.machineId.value === result.machineId)
  }
  return route.name === "schedules" && route.params.scheduleId === result.resourceId
    && (!account || account.machineId.value === result.machineId)
}

function open(result: SearchResult): void {
  const destination = result.kind === "chat"
    ? { name: "session", params: { sessionId: result.resourceId }, query: result.entryId ? { entry: result.entryId } : {} }
    : { name: "schedules", params: { scheduleId: result.resourceId } }
  if (account) account.openMachineRoute(result.machineId, destination)
  else void router.push(destination)
}
</script>

<template>
  <div role="tabpanel" aria-labelledby="sidebar-tab-search" data-sidebar-panel="search" class="flex min-h-0 flex-1 flex-col">
    <div class="shrink-0 space-y-2 px-2 pb-2">
      <form class="relative" role="search" @submit.prevent="search.refresh">
        <label :for="inputId" class="sr-only">{{ t("search.placeholder") }}</label>
        <Search :size="15" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ui-text-muted" aria-hidden="true" />
        <input
          :id="inputId"
          ref="input"
          v-model="query"
          type="search"
          class="ui-input h-8 w-full pl-8 pr-2.5 text-[13px]"
          :placeholder="t('search.placeholder')"
          :disabled="!available"
          maxlength="256"
        />
      </form>
      <div class="flex items-center gap-1" role="group" :aria-label="t('search.filter')">
        <button
          v-for="value in kinds"
          :key="value"
          type="button"
          class="cursor-pointer rounded-md px-2 py-1 text-xs ui-motion"
          :class="kind === value ? 'ui-nav-active' : 'text-ui-text-muted hover:bg-ui-hover hover:text-ui-text'"
          :aria-pressed="kind === value"
          @click="kind = value"
        >
          {{ t(`search.kind.${value}`) }}
        </button>
      </div>
    </div>

    <UiScrollArea class="min-h-0 min-w-0 flex-1" viewport-class="overscroll-contain" content-class="px-2 pb-3">
      <p v-if="!available" class="mx-2 text-xs text-ui-text-muted">{{ t("search.signIn") }}</p>
      <div v-else-if="error" class="mx-2 flex flex-col items-start gap-2 rounded-lg border border-ui-danger/30 bg-ui-danger/8 p-2.5 text-xs text-ui-danger">
        <p class="m-0 break-words" role="alert">{{ error }}</p>
        <UiButton variant="ghost" size="sm" type="button" @click="search.refresh">{{ t("folderPicker.retry") }}</UiButton>
      </div>
      <div v-else-if="!query.trim()" class="mx-2 mt-3 flex flex-col items-start gap-1 text-xs text-ui-text-faint">
        <p class="m-0 font-medium text-ui-text-muted">{{ t("search.start") }}</p>
        <p class="m-0 leading-relaxed">{{ t("search.startHint") }}</p>
      </div>
      <div v-else-if="empty" aria-live="polite" class="mx-2 mt-3 flex flex-col items-start gap-1 text-xs text-ui-text-faint">
        <p class="m-0 font-medium text-ui-text-muted">{{ t("search.empty") }}</p>
        <p class="m-0 leading-relaxed">{{ t("search.emptyHint") }}</p>
      </div>

      <ul v-if="results.length" class="m-0 flex list-none flex-col gap-1 p-0">
        <li v-for="result in results" :key="`${result.kind}:${result.machineId}:${result.resourceId}:${result.entryId ?? ''}`">
          <button
            type="button"
            data-sidebar-search-result
            class="ui-nav-item h-auto min-h-10 w-full flex-col items-start gap-0.5 px-2.5 py-2 text-left"
            :class="isActiveResult(result) && 'ui-nav-active'"
            :aria-current="isActiveResult(result) ? 'page' : undefined"
            @click="open(result)"
          >
            <span class="flex w-full min-w-0 items-center gap-1.5">
              <component :is="result.kind === 'chat' ? MessagesSquare : CalendarClock" :size="14" :stroke-width="1.75" class="shrink-0 opacity-75" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-[13px] font-medium"><SearchHighlight :text="result.title || t('search.untitled')" :query="query" /></span>
            </span>
            <span v-if="result.snippet" class="line-clamp-2 w-full break-words pl-5 text-xs leading-4 text-ui-text-muted">
              <SearchHighlight :text="result.snippet" :query="query" />
            </span>
            <span class="w-full truncate pl-5 text-[11px] text-ui-text-faint">
              {{ result.machineName }}<template v-if="result.workspaceName"> · {{ result.workspaceName }}</template>
            </span>
          </button>
        </li>
      </ul>

      <p v-if="loading" class="mx-2 flex items-center gap-2 py-3 text-xs text-ui-text-muted">
        <LoaderCircle :size="14" class="animate-spin" aria-hidden="true" />
        {{ t("search.loading") }}
      </p>
      <div v-else-if="nextCursor" class="mt-2 px-1">
        <UiButton variant="ghost" size="sm" type="button" class="w-full" @click="search.loadMore">{{ t("search.more") }}</UiButton>
      </div>
    </UiScrollArea>
  </div>
</template>
