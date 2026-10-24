<script setup lang="ts">
import { storeToRefs } from "pinia"
import { useI18n } from "vue-i18n"
import { useRouteResource } from "../../composables/useRouteResource.ts"
import { useLayoutStore, type DetailsTab } from "../../stores/layout.ts"
import GitChanges from "./GitChanges.vue"
import ResourceDetails from "./ResourceDetails.vue"

const { t } = useI18n()
const { detailsTab } = storeToRefs(useLayoutStore())
const { resource, worktree } = useRouteResource()

const tabs: { id: DetailsTab; labelKey: string }[] = [
  { id: "details", labelKey: "panel.details" },
  { id: "changes", labelKey: "panel.changes" },
]

// Arrow keys move between tabs, following the WAI-ARIA tabs pattern.
function selectAdjacent(event: KeyboardEvent, offset: number): void {
  const index = tabs.findIndex(({ id }) => id === detailsTab.value)
  const next = tabs[(index + offset + tabs.length) % tabs.length]!
  detailsTab.value = next.id
  const tablist = (event.currentTarget as HTMLElement).parentElement
  tablist?.querySelector<HTMLElement>(`#details-tab-${next.id}`)?.focus()
}
</script>

<template>
  <aside
    :aria-label="t('panel.label')"
    class="flex w-72 shrink-0 flex-col border-l border-ui-border bg-ui-canvas"
  >
    <div class="titlebar-overlay-inset app-drag flex h-12 shrink-0 items-center pl-3">
      <div role="tablist" class="app-no-drag flex gap-1">
        <button
          v-for="tab in tabs"
          :id="`details-tab-${tab.id}`"
          :key="tab.id"
          type="button"
          role="tab"
          class="h-7 cursor-pointer rounded-md px-2.5 text-[13px]"
          :class="detailsTab === tab.id ? 'bg-ui-active font-medium' : 'text-ui-text-muted hover:bg-ui-hover'"
          :aria-selected="detailsTab === tab.id"
          aria-controls="details-tabpanel"
          :tabindex="detailsTab === tab.id ? 0 : -1"
          @click="detailsTab = tab.id"
          @keydown.right.prevent="selectAdjacent($event, 1)"
          @keydown.left.prevent="selectAdjacent($event, -1)"
        >
          {{ t(tab.labelKey) }}
        </button>
      </div>
    </div>

    <div
      id="details-tabpanel"
      role="tabpanel"
      :aria-labelledby="`details-tab-${detailsTab}`"
      class="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-1"
    >
      <template v-if="detailsTab === 'details'">
        <ResourceDetails v-if="resource" :resource="resource" />
        <p v-else class="m-0 text-[13px] text-ui-text-muted">{{ t("panel.nothingSelected") }}</p>
      </template>
      <template v-else>
        <GitChanges v-if="worktree" :key="worktree.session.id" :session-id="worktree.session.id" :enabled="worktree.machine.local && worktree.machine.online" />
        <p v-else class="m-0 text-[13px] text-ui-text-muted">{{ t("panel.noWorktree") }}</p>
      </template>
    </div>
  </aside>
</template>
