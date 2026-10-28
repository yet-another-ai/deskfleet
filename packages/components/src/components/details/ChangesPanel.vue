<script setup lang="ts">
import { X } from "@lucide/vue"
import { useEventListener } from "@vueuse/core"
import { storeToRefs } from "pinia"
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { useRouteWorktree } from "../../composables/useRouteWorktree.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { activeDetailsTab, closeMermaidSidebarTab, mermaidSidebarTabs, useLayoutStore } from "../../stores/layout.ts"
import MermaidViewer from "../session/MermaidViewer.vue"
import GitChanges from "./GitChanges.vue"

const { t } = useI18n()
const worktree = useRouteWorktree()
const agents = useAgentSessionsStore()
const { detailsWidth } = storeToRefs(useLayoutStore())
const minimum = 220
const maximum = 520
const clamp = (width: number) => Math.round(Math.min(Math.max(width, minimum), maximum))
const width = computed(() => clamp(detailsWidth.value))
const resizing = ref<{ startX: number; startWidth: number } | null>(null)

function startResize(event: PointerEvent): void {
  resizing.value = { startX: event.clientX, startWidth: width.value }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
useEventListener("pointermove", (event: PointerEvent) => {
  if (resizing.value) detailsWidth.value = clamp(resizing.value.startWidth + resizing.value.startX - event.clientX)
})
useEventListener(["pointerup", "pointercancel"], () => { resizing.value = null })
function keyResize(event: KeyboardEvent): void {
  const step = event.shiftKey ? 64 : 16
  if (event.key === "ArrowLeft") detailsWidth.value = clamp(width.value + step)
  else if (event.key === "ArrowRight") detailsWidth.value = clamp(width.value - step)
  else return
  event.preventDefault()
}

const unavailable = computed(() => {
  const session = worktree.value && agents.sessions[worktree.value.session.id]
  const archiveState = session?.archiveState ?? worktree.value?.session.archiveState
  if (archiveState && archiveState !== "active") return t(archiveState === "archived" ? "agent.archived" : "agent.archiving")
  if (session && session.lifecycle !== "ready") return t(`agent.lifecycle.${session.lifecycle}`)
  return null
})
const currentTab = computed(() =>
  mermaidSidebarTabs.value.some(tab => tab.id === activeDetailsTab.value) ? activeDetailsTab.value : "changes",
)
const tabTitle = (index: number) => mermaidSidebarTabs.value.length > 1 ? `${t("mermaid.title")} ${index + 1}` : t("mermaid.title")
</script>

<template>
  <aside
    :aria-label="t('panel.changes')"
    class="relative flex shrink-0 flex-col border-l border-ui-border bg-ui-canvas"
    :style="{ width: `${width}px` }"
  >
    <div
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :aria-label="t('toolbar.resizePanel')"
      :aria-valuenow="width"
      :aria-valuemin="minimum"
      :aria-valuemax="maximum"
      class="app-no-drag absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize after:pointer-events-none after:absolute after:inset-y-0 after:left-3.5px after:w-0.5 after:bg-transparent after:transition-colors after:duration-125 after:ease-out after:content-[''] hover:after:bg-ui-focus/50 focus-visible:after:bg-ui-focus/50"
      :class="resizing && 'after:!bg-ui-focus/50'"
      @pointerdown="startResize"
      @keydown="keyResize"
    />
    <TabsRoot v-if="mermaidSidebarTabs.length" :model-value="currentTab" class="flex min-h-0 flex-1 flex-col" @update:model-value="activeDetailsTab = String($event)">
      <div class="titlebar-overlay-inset app-drag flex h-12 shrink-0 items-center border-b border-ui-border px-2">
        <TabsList :aria-label="t('panel.changes')" class="app-no-drag flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto" loop>
          <TabsTrigger value="changes" class="flex h-full shrink-0 cursor-pointer items-center border-b-2 px-2.5 text-[13px] font-medium" :class="currentTab === 'changes' ? 'border-ui-accent text-ui-accent' : 'border-transparent text-ui-text-muted hover:text-ui-text'">{{ t('panel.changes') }}</TabsTrigger>
          <div v-for="(tab, index) in mermaidSidebarTabs" :key="tab.id" role="presentation" class="group flex h-full shrink-0 items-center border-b-2 pr-1" :class="currentTab === tab.id ? 'border-ui-accent text-ui-accent' : 'border-transparent text-ui-text-muted hover:text-ui-text'">
            <TabsTrigger :value="tab.id" :data-mermaid-tab="tab.id" class="flex h-full cursor-pointer items-center pl-2.5 pr-1 text-[13px] font-medium">{{ tabTitle(index) }}</TabsTrigger>
            <button type="button" :aria-label="t('mermaid.closeTab', { title: tabTitle(index) })" :title="t('mermaid.closeTab', { title: tabTitle(index) })" data-mermaid-tab-close class="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-ui-text-muted hover:bg-ui-hover hover:text-ui-text" @click.stop="closeMermaidSidebarTab(tab.id)"><X :size="13" aria-hidden="true" /></button>
          </div>
        </TabsList>
      </div>
      <TabsContent value="changes" class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <GitChanges v-if="worktree && !unavailable" :key="worktree.session.id" class="min-h-0 min-w-0 flex-1" :session-id="worktree.session.id" :enabled="worktree.machine.online" />
        <p v-else class="m-0 px-4 pt-3 text-[13px] text-ui-text-muted">{{ unavailable ?? t('panel.noWorktree') }}</p>
      </TabsContent>
      <TabsContent v-for="tab in mermaidSidebarTabs" :key="tab.id" :value="tab.id" data-mermaid-sidebar-view class="flex min-h-0 flex-1 flex-col p-2">
        <MermaidViewer :code="tab.code" :source="tab.source" mode="sidebar" class="min-h-0 flex-1" />
      </TabsContent>
    </TabsRoot>
    <template v-else>
      <div class="titlebar-overlay-inset app-drag flex h-12 shrink-0 items-center pl-4">
        <h2 class="m-0 text-[13px] font-medium">{{ t('panel.changes') }}</h2>
      </div>
      <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <GitChanges v-if="worktree && !unavailable" :key="worktree.session.id" class="min-h-0 min-w-0 flex-1" :session-id="worktree.session.id" :enabled="worktree.machine.online" />
        <p v-else class="m-0 px-4 pt-1 text-[13px] text-ui-text-muted">{{ unavailable ?? t('panel.noWorktree') }}</p>
      </div>
    </template>
  </aside>
</template>
