<script setup lang="ts">
import { Search } from "@lucide/vue"
import { watch } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute } from "vue-router"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import UiScrollArea from "../components/common/UiScrollArea.vue"
import { useAccountSession } from "../composables/useAccountSession.ts"
import type { SearchKind } from "../composables/useSearch.ts"
import { useSidebarPanel } from "../composables/useSidebarPanel.ts"
import { useLayoutStore } from "../stores/layout.ts"

const { t } = useI18n()
const route = useRoute()
const account = useAccountSession()
const layout = useLayoutStore()
const sidebarPanel = useSidebarPanel()
const readKind = (value: unknown): SearchKind => value === "chat" || value === "schedule" ? value : "all"

// Deep links to `/search?q=&kind=` activate and populate the sidebar search panel instead of duplicating search UI.
watch(() => [route.name, route.query.q, route.query.kind] as const, ([name, q, kind]) => {
  if (name !== "search") return
  sidebarPanel.panel.value = "search"
  if (typeof q === "string") sidebarPanel.searchQuery.value = q
  sidebarPanel.searchKind.value = readKind(kind)
  if (layout.compact) layout.sidebarOpen = true
}, { immediate: true })
</script>

<template>
  <PaneHeader>{{ t('search.title') }}</PaneHeader>
  <UiScrollArea class="min-h-0 flex-1" viewport-class="px-5 pb-10 pt-6 lg:px-8">
    <div class="mx-auto flex max-w-2xl flex-col gap-5">
      <div class="ui-empty">
        <Search :size="25" class="mb-2 text-ui-text-muted" aria-hidden="true" />
        <p class="m-0 text-sm font-medium">{{ t('search.title') }}</p>
        <p class="m-0 max-w-md text-center text-[13px] leading-5 text-ui-text-muted">{{ t('search.description', { team: account?.team.value?.name ?? '' }) }}</p>
      </div>
    </div>
  </UiScrollArea>
</template>
