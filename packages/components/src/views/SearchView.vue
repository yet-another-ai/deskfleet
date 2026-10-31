<script setup lang="ts">
import { CalendarClock, LoaderCircle, MessagesSquare, Search } from "@lucide/vue"
import { useFocus } from "@vueuse/core"
import { computed, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter } from "vue-router"
import type { SearchResult } from "@deskfleet/client/search"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import UiButton from "../components/common/UiButton.vue"
import SearchHighlight from "../components/search/SearchHighlight.vue"
import { useAccountSession } from "../composables/useAccountSession.ts"
import { useSearch, type SearchKind } from "../composables/useSearch.ts"

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const account = useAccountSession()
const readKind = (value: unknown): SearchKind => value === "chat" || value === "schedule" ? value : "all"
const query = ref(typeof route.query.q === "string" ? route.query.q : "")
const kind = ref<SearchKind>(readKind(route.query.kind))
const kinds = ["all", "chat", "schedule"] as const
const search = useSearch(query, kind)
const { results, nextCursor, loading, error, available, enabled } = search
const input = useTemplateRef<HTMLInputElement>("input")
useFocus(input, { initialValue: true })
const empty = computed(() => !!query.value.trim() && !loading.value && !error.value && !results.value.length)
watch(enabled, value => {
  if (!value && route.name === "search") void router.replace({ name: "new-session" })
}, { immediate: true })

watch(() => route.query, values => {
  if (route.name !== "search") return
  query.value = typeof values.q === "string" ? values.q : ""
  kind.value = readKind(values.kind)
})
watch(() => route.fullPath, path => {
  if (route.name === "search" && account) account.searchPath.value = path
}, { immediate: true })
watch([query, kind], ([q, selected]) => {
  if (route.name !== "search") return
  void router.replace({ name: "search", query: { ...(q ? { q } : {}), ...(selected !== "all" ? { kind: selected } : {}) } })
})
watch(() => account?.teamId.value, () => { query.value = ""; kind.value = "all" })

function open(result: SearchResult): void {
  account?.openMachineRoute(result.machineId, result.kind === "chat"
    ? { name: "session", params: { sessionId: result.resourceId }, query: result.entryId ? { entry: result.entryId } : {} }
    : { name: "schedules", params: { scheduleId: result.resourceId } })
}
</script>

<template>
  <template v-if="enabled">
  <PaneHeader hide-details>{{ t('search.title') }}</PaneHeader>
  <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-6 lg:px-8">
    <div class="mx-auto flex max-w-4xl flex-col gap-5">
      <header>
        <h1 class="ui-page-title">{{ t('search.title') }}</h1>
        <p class="m-0 mt-1 text-sm text-ui-text-muted">{{ t('search.description', { team: account?.team.value?.name ?? '' }) }}</p>
      </header>
      <form class="relative" role="search" @submit.prevent="search.refresh">
        <Search :size="18" class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ui-text-muted" aria-hidden="true" />
        <input ref="input" v-model="query" type="search" class="ui-input w-full py-3 pl-11 pr-4 text-[15px]" :placeholder="t('search.placeholder')" :aria-label="t('search.placeholder')" :disabled="!available" maxlength="256" />
      </form>
      <div class="flex gap-1.5" role="group" :aria-label="t('search.filter')">
        <button v-for="value in kinds" :key="value" type="button" class="cursor-pointer rounded-full px-3 py-1.5 text-[13px] transition-colors" :class="kind === value ? 'bg-ui-active text-ui-text' : 'text-ui-text-muted hover:bg-ui-hover'" :aria-pressed="kind === value" @click="kind = value">{{ t(`search.kind.${value}`) }}</button>
      </div>
      <p v-if="!available" class="ui-notice m-0" role="status">{{ t('search.signIn') }}</p>
      <div v-else-if="error" class="ui-notice m-0 justify-between border-ui-danger/30 bg-ui-danger/8">
        <p class="m-0 text-ui-danger" role="alert">{{ error }}</p><UiButton type="button" @click="search.refresh">{{ t('folderPicker.retry') }}</UiButton>
      </div>
      <div v-if="available && (!query.trim() || empty)" class="ui-empty">
        <Search :size="25" class="mb-2 text-ui-text-muted" aria-hidden="true" />
        <p class="m-0 text-sm font-medium">{{ t(empty ? 'search.empty' : 'search.start') }}</p>
        <p class="m-0 max-w-md text-center text-[13px] leading-5 text-ui-text-muted">{{ t(empty ? 'search.emptyHint' : 'search.startHint') }}</p>
      </div>
      <ul v-if="results.length" class="ui-card m-0 list-none divide-y divide-ui-border p-0">
        <li v-for="result in results" :key="`${result.kind}:${result.machineId}:${result.resourceId}:${result.entryId ?? ''}`">
          <button type="button" data-search-result class="flex w-full cursor-pointer items-start gap-3.5 px-4 py-4 text-left transition-colors hover:bg-ui-hover" @click="open(result)">
            <component :is="result.kind === 'chat' ? MessagesSquare : CalendarClock" :size="18" :stroke-width="1.75" class="mt-0.5 shrink-0 text-ui-text-muted" aria-hidden="true" />
            <div class="min-w-0 flex-1">
              <p class="m-0 truncate text-sm font-medium"><SearchHighlight :text="result.title || t('search.untitled')" :query="query" /></p>
              <p v-if="result.snippet" class="m-0 mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-5 text-ui-text-muted"><SearchHighlight :text="result.snippet" :query="query" /></p>
              <p class="m-0 mt-2 truncate text-xs text-ui-text-faint">{{ t(`search.kind.${result.kind}`) }} · {{ result.machineName }}<template v-if="result.workspaceName"> · {{ result.workspaceName }}</template></p>
            </div>
          </button>
        </li>
      </ul>
      <p v-if="loading" role="status" class="m-0 flex items-center justify-center gap-2 py-5 text-sm text-ui-text-muted"><LoaderCircle :size="16" class="animate-spin" aria-hidden="true" />{{ t('search.loading') }}</p>
      <UiButton v-else-if="nextCursor" class="self-center" type="button" @click="search.loadMore">{{ t('search.more') }}</UiButton>
    </div>
  </div>
  </template>
</template>
